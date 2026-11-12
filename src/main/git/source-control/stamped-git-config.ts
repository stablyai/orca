import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { BoundedMap } from '../../../shared/bounded-map'
import { resolveWorktreeHostPath } from '../../../shared/git/metadata/git-metadata-path'
import { InFlightPromiseDedupe } from '../../../shared/in-flight-promise-dedupe'
import { iterateNulDelimitedFields } from '../../../shared/nul-delimited-fields'
import { wslDistroForCommand } from '../../../shared/wsl-paths'
import {
  gitReadOptionsForWorktree,
  type GitRuntimeOptions
} from '../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { readStampWithinDeadline, type StampProbes } from './deadline-bounded-stamp'
import { resolveGitCommonDir, resolveGitDir } from './resolve-git-dir'
import {
  canProveUnchangedByStamp,
  readHostFilesStamp,
  type WorktreeDiffStamp
} from './worktree-diff-stamp'

/** Effective Git config of a worktree whose config inputs the host can stamp. */
export type StampedGitConfig = {
  /** Canonical keys; the last value wins, as in Git. A bare key reads as `true`. */
  values: ReadonlyMap<string, string>
  /** Host paths of every config input: files Git read, include targets, and standard files it could create. */
  files: readonly string[]
  /** info/attributes and the global attributes file, which shape diffs without being config. */
  attributeFiles: readonly string[]
}

type CachedConfig = {
  config: StampedGitConfig
  /** Null when the read could not prove its files unchanged; the entry then only seeds the next stamp. */
  stamp: WorktreeDiffStamp | null
  atMs: number
}

// System config created after a read has no known path to stamp; bound how long that can go unseen.
const STAMPED_GIT_CONFIG_MAX_AGE_MS = 5 * 60_000
const cachedConfigs = new BoundedMap<string, CachedConfig>({ maxEntries: 256 })
const configReads = new InFlightPromiseDedupe<StampedGitConfig | null>()

const configStampProbes: StampProbes = new Map()

function readConfigFilesStamp(
  worktreePath: string,
  files: readonly string[]
): Promise<WorktreeDiffStamp | null> {
  return readStampWithinDeadline(configStampProbes, JSON.stringify([worktreePath, files]), () =>
    readHostFilesStamp(files)
  )
}

/** True where Node cannot stamp what Git reads: WSL Git uses the distro's files, not the host's. */
function runsGitInWsl(worktreePath: string, options: GitRuntimeOptions): boolean {
  return Boolean(options.wslDistro || wslDistroForCommand(worktreePath))
}

/** Read config once and reuse it while every stamped input is unchanged, so polls spawn nothing; null when unstampable. */
export async function readStampedGitConfig(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<StampedGitConfig | null> {
  if (runsGitInWsl(worktreePath, options)) {
    return null
  }
  const key = worktreePath
  const cached = cachedConfigs.get(key)
  if (cached?.stamp && performance.now() - cached.atMs < STAMPED_GIT_CONFIG_MAX_AGE_MS) {
    const stamp = await readConfigFilesStamp(key, cached.config.files)
    if (!stamp) {
      return null
    }
    if (stamp.value === cached.stamp.value) {
      return cached.config
    }
  }
  // Shared by concurrent pollers, so one caller's abort must not cancel the others' read.
  const { signal: _signal, ...sharedOptions } = options
  return configReads.run(key, () => readConfig(worktreePath, sharedOptions, cached))
}

async function readConfig(
  worktreePath: string,
  options: GitRuntimeOptions,
  cached: CachedConfig | undefined
): Promise<StampedGitConfig | null> {
  const locations = await resolveConfigLocations(worktreePath, options)
  if (!locations) {
    return null
  }
  // Stamp before reading, including inputs the last read named, so an edit during the read invalidates.
  const stampedFiles = [...new Set([...locations.candidates, ...(cached?.config.files ?? [])])]
  const stampBefore = await readConfigFilesStamp(worktreePath, stampedFiles)
  if (!stampBefore) {
    return null
  }
  let stdout: string
  try {
    stdout = (
      await gitExecFileAsync(
        ['config', '--list', '--show-origin', '-z'],
        gitReadOptionsForWorktree(worktreePath, options)
      )
    ).stdout
  } catch {
    return null
  }
  const { values, inputFiles } = parseConfigList(stdout, locations)
  const files = [...new Set([...stampedFiles, ...inputFiles])]
  const config: StampedGitConfig = {
    values,
    files,
    attributeFiles: [
      path.join(locations.commonDir, 'info', 'attributes'),
      globalAttributesFile(values.get('core.attributesfile'), locations.hostWorktreePath)
    ]
  }
  // Inputs first named by this read were not stamped before it; keep them so the next read can cache.
  const provable =
    stampBefore !== null &&
    files.length === stampedFiles.length &&
    canProveUnchangedByStamp(stampBefore)
  cachedConfigs.set(worktreePath, {
    config,
    stamp: provable ? stampBefore : null,
    atMs: performance.now()
  })
  return config
}

type ConfigLocations = {
  hostWorktreePath: string
  gitDir: string
  commonDir: string
  candidates: string[]
}

async function resolveConfigLocations(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<ConfigLocations | null> {
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options)
  if (!hostWorktreePath) {
    return null
  }
  const gitDir = await resolveGitDir(hostWorktreePath, options)
  // A folder inside a repository has no gitdir of its own, so its repo config path is unknown.
  let commonDir: string
  try {
    await access(gitDir)
    commonDir = await resolveGitCommonDir(gitDir)
  } catch {
    return null
  }
  const { home, xdgConfigHome } = gitHomeDirectories()
  const candidates = [
    path.join(commonDir, 'config'),
    path.join(gitDir, 'config.worktree'),
    ...(process.env.GIT_CONFIG_GLOBAL
      ? [process.env.GIT_CONFIG_GLOBAL]
      : [path.join(home, '.gitconfig'), path.join(xdgConfigHome, 'git', 'config')]),
    ...(process.env.GIT_CONFIG_SYSTEM ? [process.env.GIT_CONFIG_SYSTEM] : [])
  ]
  return { hostWorktreePath, gitDir, commonDir, candidates }
}

/** Parse `--list --show-origin -z` (`<origin>\0<key>\n<value>\0`) into values and every file that feeds them. */
function parseConfigList(
  stdout: string,
  locations: ConfigLocations
): { values: Map<string, string>; inputFiles: string[] } {
  const values = new Map<string, string>()
  const inputFiles = new Set<string>()
  let origin: string | null = null
  for (const field of iterateNulDelimitedFields(stdout)) {
    if (origin === null) {
      origin = field
      continue
    }
    // Repository files print relative to the worktree.
    const originFile = origin.startsWith('file:')
      ? path.resolve(locations.hostWorktreePath, origin.slice('file:'.length))
      : null
    origin = null
    const newline = field.indexOf('\n')
    const key = newline === -1 ? field : field.slice(0, newline)
    const value = newline === -1 ? 'true' : field.slice(newline + 1)
    values.set(key, value)
    if (originFile) {
      inputFiles.add(originFile)
    }
    // Include targets may be empty or missing now and filled in later.
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
      inputFiles.add(
        resolveConfigPath(value, originFile ? path.dirname(originFile) : locations.hostWorktreePath)
      )
    }
    // onbranch: conditions switch with the checked-out branch.
    if (key.startsWith('includeif.') && key.toLowerCase().includes('.onbranch:')) {
      inputFiles.add(path.join(locations.gitDir, 'HEAD'))
    }
  }
  return { values, inputFiles: [...inputFiles] }
}

function resolveConfigPath(value: string, baseDirectory: string): string {
  if (value.startsWith('~/')) {
    return path.join(gitHomeDirectories().home, value.slice(2))
  }
  return path.resolve(baseDirectory, value)
}

function globalAttributesFile(configured: string | undefined, hostWorktreePath: string): string {
  if (configured) {
    return resolveConfigPath(configured, hostWorktreePath)
  }
  return path.join(gitHomeDirectories().xdgConfigHome, 'git', 'attributes')
}

/** Git's own HOME resolution, including Windows' HOMEDRIVE/HOMEPATH before USERPROFILE. */
function gitHomeDirectories(): { home: string; xdgConfigHome: string } {
  const env = process.env
  const windowsHome =
    process.platform === 'win32' && env.HOMEDRIVE && env.HOMEPATH
      ? path.join(env.HOMEDRIVE, env.HOMEPATH)
      : undefined
  const home = env.HOME || windowsHome || homedir()
  return { home, xdgConfigHome: env.XDG_CONFIG_HOME || path.join(home, '.config') }
}
