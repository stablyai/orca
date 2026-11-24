import { basename, dirname, join } from 'node:path'
import type { GitBlameResult } from '../../../../shared/git/blame/git-blame-types'
import { parseGitBlameIncremental } from '../../../../shared/git/blame/git-blame-incremental-parser'
import { InFlightPromiseDedupe } from '../../../../shared/concurrency/in-flight-promise-dedupe'
import {
  type GitRuntimeOptions,
  gitReadOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { isMaxBufferOverflowError } from '../../command-runner/process-capture/max-buffer-overflow'
import { readGitBlobAtOidPath, type BlobConversion } from '../diffs/git-blob-read'
import { readGitCommandFailureStderr } from '../../../../shared/git/commands/git-command-failure-text'
import { GitBlameResultCache } from './git-blame-result-cache'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'

const UNAVAILABLE: GitBlameResult = { kind: 'unavailable' }
// No filter or textconv pass, and no attribute lookup to decide one.
const RAW_BLOB: BlobConversion = { mode: 'checkout', hasDriver: Promise.resolve(false) }

// Keyed by commit, so entries never go stale; HEAD moving produces a new key.
const blameCache = new GitBlameResultCache()
const blameReadDedupe = new InFlightPromiseDedupe<GitBlameResult>(180_000)

/**
 * Blame `filePath` as committed at HEAD. Git runs from the file's own directory so it finds the
 * repo that owns the file, which may be a child repo of a folder workspace.
 */
export async function getBlame(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {},
  knownHeadOid?: string
): Promise<GitBlameResult> {
  const fileDir = join(worktreePath, dirname(filePath))
  const head = await resolveHead(fileDir, options)
  if (!head) {
    return UNAVAILABLE
  }
  // Unshallowing keeps HEAD but changes blame, so shallowness is part of the baseline identity.
  const baseline = head.shallow ? `${head.oid}+shallow` : head.oid
  if (baseline === knownHeadOid) {
    return { kind: 'unchanged' }
  }
  const fileName = basename(filePath)
  const repoPath = `${head.prefix}${fileName}`
  const key = `${head.commonDir}\0${baseline}\0${repoPath}`
  const cached = blameCache.get(key)
  if (cached) {
    return cached
  }
  return blameReadDedupe.run(key, async () => {
    const result = await readBlame(fileDir, fileName, repoPath, head.oid, options)
    if (result.kind === 'ready') {
      result.headOid = baseline
    }
    if (result.kind !== 'unavailable') {
      blameCache.set(key, result)
    }
    return result
  })
}

async function resolveHead(
  fileDir: string,
  options: GitRuntimeOptions
): Promise<{ oid: string; commonDir: string; prefix: string; shallow: boolean } | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        'rev-parse',
        '--git-common-dir',
        '--show-prefix',
        '--is-shallow-repository',
        '--verify',
        '--quiet',
        'HEAD^{commit}'
      ],
      gitReadOptionsForWorktree(fileDir, options)
    )
    // The prefix line is empty at the repo root, so split without trimming inner lines.
    const [commonDir, prefix, shallow, oid] = stdout
      .replace(/\r/g, '')
      .replace(/\n$/, '')
      .split('\n')
    if (!commonDir || prefix === undefined || !oid) {
      return null
    }
    const isAbsolute = /^([a-zA-Z]:)?[\\/]/.test(commonDir)
    return {
      oid,
      prefix,
      commonDir: isAbsolute ? commonDir : `${fileDir}/${commonDir}`,
      shallow: shallow === 'true'
    }
  } catch {
    // No commits yet, or not inside a repository.
    return null
  }
}

function withoutGlobalGitConfig(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  // WSL git only sees variables listed in WSLENV.
  addWslEnvKeys(env, ['GIT_CONFIG_GLOBAL'])
  return env
}

async function runBlame(
  fileDir: string,
  fileName: string,
  oid: string,
  options: GitRuntimeOptions,
  withoutGlobalConfig = false
): Promise<{ stdout: string } | 'too-large' | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      // Source-line coordinates: a textconv driver would renumber lines away from headText.
      ['blame', '--root', '--incremental', '--no-textconv', oid, '--', fileName],
      {
        ...gitReadOptionsForWorktree(fileDir, options),
        ...(withoutGlobalConfig ? { env: withoutGlobalGitConfig() } : {})
      }
    )
    return { stdout }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return 'too-large'
    }
    // A global blame.ignoreRevsFile naming a file this repo lacks fails every blame, and git can't
    // clear that multi-valued key from the command line, so retry once without global config.
    const stderr = readGitCommandFailureStderr(error) ?? ''
    if (!withoutGlobalConfig && stderr.includes('could not open object name list')) {
      return runBlame(fileDir, fileName, oid, options, true)
    }
    return null
  }
}

async function readBlame(
  fileDir: string,
  fileName: string,
  repoPath: string,
  oid: string,
  options: GitRuntimeOptions
): Promise<GitBlameResult> {
  const readOptions = { ...options, admissionTier: options.admissionTier ?? 'background' }
  // The raw blob, in the same line coordinates as `blame --no-textconv`; filtered lines read as
  // edits rather than shifting attribution. `oid:path` is repo-root relative from any cwd.
  const blobRead = readGitBlobAtOidPath(fileDir, oid, repoPath, readOptions, RAW_BLOB)
  const [blob, blameOutput] = await Promise.all([
    blobRead,
    runBlame(fileDir, fileName, oid, readOptions)
  ])

  if (blob.tooLarge || blameOutput === 'too-large') {
    return { kind: 'too-large' }
  }
  if (!blob.exists) {
    return blob.failed ? UNAVAILABLE : { kind: 'untracked' }
  }
  if (blob.isBinary || blameOutput === null) {
    return UNAVAILABLE
  }
  return {
    kind: 'ready',
    headOid: oid,
    headText: blob.content,
    ...parseGitBlameIncremental(blameOutput.stdout)
  }
}
