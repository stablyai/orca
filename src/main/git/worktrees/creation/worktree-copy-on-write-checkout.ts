import { runProcess } from '@orca/process-host'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canCloneWithApfs } from '../../../ipc/worktree-apfs-clone'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import {
  readTreeIntoPlainIndex,
  STAT_CONCURRENCY,
  transferCleanIndexStats
} from './worktree-index-stat-transfer'
import { readGitConfigValue } from './git-config-value'
import { canReflinkIntoDirectory } from './worktree-reflink-probe'

/** `git config orca.copyOnWriteCheckout false` (repo or global) turns cloned checkouts off. */
export const COPY_ON_WRITE_CHECKOUT_CONFIG_KEY = 'orca.copyOnWriteCheckout'

export type CloneMethod = 'apfs' | 'reflink'

const CLONE_BATCH_SIZE = 256
const CLONE_CONCURRENCY = 8
// Own bound: clearing must still run after the clone deadline or a cancel has fired.
const CLEAR_FLAGS_TIMEOUT_MS = 30_000
const LIST_MAX_BUFFER = 512 * 1024 * 1024
const REGULAR_FILE_MODES = new Set(['100644', '100755'])
// A checkout runs these, so a fresh file can differ from main's bytes that clean to the same blob.
const CHECKOUT_CONVERSION_ATTRIBUTES = ['filter', 'ident', 'working-tree-encoding']
// Decide whether a checkout can add CRs; other line-ending conversions only remove them on clean.
const LINE_ENDING_ATTRIBUTES = ['text', 'eol', 'crlf']
const GIT_TRUE = new Set(['true', 'yes', 'on', '1'])

type CloneableFile = { mode: string; size: number }

/** How this host can clone from the main checkout without silently copying, or null. */
export async function resolveCopyOnWriteCheckout(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<CloneMethod | null> {
  // WSL and Windows checkouts have no clone path; SSH hosts never reach this process.
  if (options.wslDistro || (process.platform !== 'darwin' && process.platform !== 'linux')) {
    return null
  }
  // A failed read could hide an explicit opt-out, so it disables cloning too.
  const optOut = await readGitConfigValue(repoPath, COPY_ON_WRITE_CHECKOUT_CONFIG_KEY, options, [
    '--bool'
  ]).catch(() => 'false')
  if (optOut === 'false') {
    return null
  }
  if (process.platform === 'linux') {
    return (await canReflinkIntoDirectory(repoPath, dirname(worktreePath))) ? 'reflink' : null
  }
  return (await canCloneWithApfs(repoPath, dirname(worktreePath))) ? 'apfs' : null
}

function parseEntries<T>(stdout: string, entryKey: (header: string) => T | null) {
  const entries = new Map<string, T>()
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t')
    const key = tab === -1 ? null : entryKey(record.slice(0, tab))
    if (key) {
      entries.set(record.slice(tab + 1), key)
    }
  }
  return entries
}

/** Regular files whose blob in `commit` matches the main checkout's index entry. */
async function listCloneableFiles(
  repoPath: string,
  worktreePath: string,
  commit: string,
  options: GitWorktreeExecOptions
): Promise<Map<string, CloneableFile>> {
  const listOptions = (cwd: string) => ({
    ...gitExecOptions(cwd, options),
    maxBuffer: LIST_MAX_BUFFER
  })
  const [tree, index] = await Promise.all([
    gitExecFileAsync(
      ['ls-tree', '-r', '-l', '-z', '--full-tree', commit],
      listOptions(worktreePath)
    ),
    gitExecFileAsync(['ls-files', '--stage', '-z'], listOptions(repoPath))
  ])
  // ls-tree -l: "<mode> blob <oid> <padded size>"; ls-files: "<mode> <oid> <stage>".
  const wanted = parseEntries(tree.stdout, (header) => {
    const [mode, type, oid, size] = header.split(/ +/)
    return type === 'blob' && REGULAR_FILE_MODES.has(mode)
      ? { key: `${mode} ${oid}`, mode, size: Number(size) }
      : null
  })
  const checkedOut = parseEntries(index.stdout, (header) => {
    const [mode, oid, stage] = header.split(' ')
    return stage === '0' ? `${mode} ${oid}` : null
  })
  return new Map(
    [...wanted]
      .filter(([path, { key }]) => checkedOut.get(path) === key)
      .map(([path, { mode, size }]) => [path, { mode, size }])
  )
}

const CHECKED_ATTRIBUTES = [...CHECKOUT_CONVERSION_ATTRIBUTES, ...LINE_ENDING_ATTRIBUTES]

/** Each path's values of CHECKED_ATTRIBUTES; `cached` reads the index instead of the worktree. */
async function readAttributes(
  cwd: string,
  paths: string[],
  cached: boolean,
  options: GitWorktreeExecOptions
): Promise<Map<string, Map<string, string>>> {
  const { stdout } = await gitExecFileAsync(
    ['check-attr', ...(cached ? ['--cached'] : []), '-z', '--stdin', ...CHECKED_ATTRIBUTES],
    { ...gitExecOptions(cwd, options), maxBuffer: LIST_MAX_BUFFER, stdin: paths.join('\0') }
  )
  // -z output: "<path>\0<attribute>\0<value>\0" per path and attribute.
  const attributes = new Map<string, Map<string, string>>()
  const fields = stdout.split('\0')
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const values = attributes.get(fields[i]) ?? new Map<string, string>()
    values.set(fields[i + 1], fields[i + 2])
    attributes.set(fields[i], values)
  }
  return attributes
}

/**
 * Drops files whose checkout can write bytes other than the blob's: filters (e.g. Git LFS), ident,
 * encodings, and line-ending conversion that adds CRs. Also drops files whose attributes in the
 * main checkout differ from the base's (an untracked or edited .gitattributes, a relative
 * core.attributesFile), since "clean" in the main checkout then says nothing about the blob.
 * Git writes those itself.
 */
async function withoutCheckoutConversion(
  repoPath: string,
  worktreePath: string,
  paths: string[],
  options: GitWorktreeExecOptions
): Promise<string[]> {
  const [target, source, autocrlf, eol] = await Promise.all([
    // --cached reads the attributes of the base commit that read-tree just staged.
    readAttributes(worktreePath, paths, true, options),
    readAttributes(repoPath, paths, false, options),
    // A failed read rejects, so the clone phase falls back rather than assume no conversion.
    readGitConfigValue(worktreePath, 'core.autocrlf', options),
    readGitConfigValue(worktreePath, 'core.eol', options)
  ])
  const crlfByConfig = GIT_TRUE.has(autocrlf ?? '') || eol === 'crlf'
  return paths.filter((path) => {
    const values = target.get(path)
    const sourceValues = source.get(path)
    if (CHECKED_ATTRIBUTES.some((name) => values?.get(name) !== sourceValues?.get(name))) {
      return false
    }
    const set = (name: string) => {
      const value = values?.get(name) ?? 'unspecified'
      return value !== 'unspecified' && value !== 'unset'
    }
    const addsCr =
      values?.get('eol') === 'crlf' ||
      (crlfByConfig && values?.get('text') !== 'unset' && values?.get('crlf') !== 'unset')
    return !CHECKOUT_CONVERSION_ATTRIBUTES.some(set) && !addsCr
  })
}

/**
 * Keeps sources that are regular files with the blob's size and the permissions a checkout of its
 * mode would create, since clones keep their source's mode. Clean conversion only removes CRs, so a
 * source with the blob's size holds the blob's bytes. Git writes the rest, including files deleted
 * from the main checkout, stale line endings, and exec bits hidden by core.fileMode=false.
 */
async function withFreshCheckoutStat(
  repoPath: string,
  worktreePath: string,
  paths: string[],
  files: Map<string, CloneableFile>
): Promise<string[]> {
  // Git creates the worktree's `.git` file like a checked-out file: 0666 minus the umask.
  const regular = (await lstat(join(worktreePath, '.git'))).mode & 0o777
  const executable = regular | ((regular & 0o444) >> 2)
  const keep = await mapWithConcurrency(paths, STAT_CONCURRENCY, async (path) => {
    const stat = await lstat(join(repoPath, path)).catch(() => null)
    const file = files.get(path)
    const expected = file?.mode === '100755' ? executable : regular
    return stat?.isFile() === true && (stat.mode & 0o7777) === expected && stat.size === file?.size
  })
  return paths.filter((_, i) => keep[i])
}

function runClone(
  method: CloneMethod,
  sources: string[],
  targetDirectory: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  return method === 'apfs'
    ? runTool('/bin/cp', ['-c', ...sources, targetDirectory], options)
    : // GNU cp stamps copies with the current time; keep mtimes so index stats can transfer.
      runTool(
        'cp',
        ['--reflink=always', '--preserve=timestamps', '-t', targetDirectory, ...sources],
        options
      )
}

async function runTool(
  file: string,
  args: string[],
  options: GitWorktreeExecOptions
): Promise<void> {
  let terminated = (): void => {}
  options.observeChildTermination?.(
    new Promise<void>((resolve) => {
      terminated = resolve
    }),
    true
  )
  const result = await runProcess({
    program: file,
    args,
    signal: options.signal,
    timeoutMs: null,
    onChildTerminated: () => terminated()
  })
  if (result.code !== 0) {
    throw new Error(`${file} exited with ${result.code ?? result.signal}: ${result.stderr.trim()}`)
  }
}

async function cloneFiles(
  method: CloneMethod,
  repoPath: string,
  worktreePath: string,
  paths: string[],
  options: GitWorktreeExecOptions
): Promise<void> {
  const byDirectory = new Map<string, string[]>()
  for (const path of paths) {
    const sources = byDirectory.get(dirname(path)) ?? []
    sources.push(join(repoPath, path))
    byDirectory.set(dirname(path), sources)
  }
  const batches: { targetDirectory: string; sources: string[] }[] = []
  for (const [directory, sources] of byDirectory) {
    const targetDirectory = join(worktreePath, directory)
    for (let i = 0; i < sources.length; i += CLONE_BATCH_SIZE) {
      batches.push({ targetDirectory, sources: sources.slice(i, i + CLONE_BATCH_SIZE) })
    }
  }
  // Probe with one file: an unsupported filesystem fails here, before any batch runs.
  const [first] = batches
  await mkdir(first.targetDirectory, { recursive: true })
  await runClone(method, first.sources.slice(0, 1), first.targetDirectory, options)
  first.sources = first.sources.slice(1)
  let next = 0
  const workers = Array.from({ length: Math.min(CLONE_CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) {
      options.signal?.throwIfAborted()
      const batch = batches[next++]
      if (batch.sources.length > 0) {
        await mkdir(batch.targetDirectory, { recursive: true })
        // A file missing or changed in the main checkout fails alone; Git rewrites it below.
        await runClone(method, batch.sources, batch.targetDirectory, options).catch(() => {})
      }
    }
  })
  await Promise.all(workers)
}

/**
 * Fills a `--no-checkout` worktree with clones of the main checkout's files that already match
 * `commit`, then records them in the index, so the caller's `reset --hard` writes only what
 * differs. Clones share disk blocks with the main checkout until either side changes. Failing to
 * clone leaves the worktree for an ordinary checkout.
 */
export async function cloneMainCheckoutIntoWorktree(
  method: CloneMethod,
  repoPath: string,
  worktreePath: string,
  commit: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    const candidates = await listCloneableFiles(repoPath, worktreePath, commit, options)
    if (candidates.size === 0) {
      return
    }
    await readTreeIntoPlainIndex(worktreePath, commit, options)
    const paths = await withFreshCheckoutStat(
      repoPath,
      worktreePath,
      await withoutCheckoutConversion(repoPath, worktreePath, [...candidates.keys()], options),
      candidates
    )
    if (paths.length === 0) {
      return
    }
    // The same bound as a checkout, so a stalled filesystem falls back instead of hanging the create.
    const deadline = AbortSignal.timeout(resolveWorktreeAddTimeoutMs())
    const cloneOptions = {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    }
    let cloned = false
    try {
      await cloneFiles(method, repoPath, worktreePath, paths, cloneOptions)
      cloned = true
    } finally {
      if (method === 'apfs') {
        // APFS clones keep file flags; a checkout never sets the ones that block editing or
        // deleting. Clear them after partial clones too, so the fallback and rollback can rewrite.
        const clearing = runTool('/usr/bin/chflags', ['-R', 'nouchg,nouappnd', worktreePath], {
          ...options,
          signal: AbortSignal.timeout(CLEAR_FLAGS_TIMEOUT_MS)
        })
        await (cloned ? clearing : clearing.catch(() => {}))
      }
    }
    // Skips Git's re-read for clones of files it already knows are clean.
    await transferCleanIndexStats(repoPath, worktreePath, options).catch(() => 0)
    // Refresh compares content, so a clone that differs from its blob stays dirty and is rewritten.
    await gitExecFileAsync(
      ['update-index', '-q', '--refresh'],
      gitExecOptions(worktreePath, options)
    ).catch(() => {})
  } catch (error) {
    options.signal?.throwIfAborted()
    console.warn(`[worktree-copy-on-write] falling back to a full checkout: ${String(error)}`)
  }
}
