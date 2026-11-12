import { runProcess } from '@orca/process-host'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canCloneWithApfs } from '../../../ipc/worktree-apfs-clone'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitExecOptions, type GitWorktreeExecOptions } from '../worktree-operation-options'
import { readTreeIntoPlainIndex, transferCleanIndexStats } from './worktree-index-stat-transfer'

/** `git config orca.copyOnWriteCheckout false` (repo or global) turns cloned checkouts off. */
export const COPY_ON_WRITE_CHECKOUT_CONFIG_KEY = 'orca.copyOnWriteCheckout'

export type CloneMethod = 'apfs' | 'reflink'

const CLONE_BATCH_SIZE = 256
const CLONE_CONCURRENCY = 8
const LIST_MAX_BUFFER = 512 * 1024 * 1024
const REGULAR_FILE_MODES = new Set(['100644', '100755'])
// A checkout runs these, so a fresh file can differ from main's bytes that clean to the same blob.
const CHECKOUT_CONVERSION_ATTRIBUTES = ['filter', 'ident', 'working-tree-encoding']

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
  const disabled = await gitExecFileAsync(
    ['config', '--bool', '--get', COPY_ON_WRITE_CHECKOUT_CONFIG_KEY],
    gitExecOptions(repoPath, options)
  ).then(
    ({ stdout }) => stdout.trim() === 'false',
    () => false
  )
  if (disabled) {
    return null
  }
  if (process.platform === 'linux') {
    // `cp --reflink=always` fails instead of copying, so the first clone is the probe.
    return 'reflink'
  }
  return (await canCloneWithApfs(repoPath, dirname(worktreePath))) ? 'apfs' : null
}

function parseEntries(stdout: string, entryKey: (header: string) => string | null) {
  const entries = new Map<string, string>()
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
): Promise<string[]> {
  const listOptions = (cwd: string) => ({
    ...gitExecOptions(cwd, options),
    maxBuffer: LIST_MAX_BUFFER
  })
  const [tree, index] = await Promise.all([
    gitExecFileAsync(['ls-tree', '-r', '-z', '--full-tree', commit], listOptions(worktreePath)),
    gitExecFileAsync(['ls-files', '--stage', '-z'], listOptions(repoPath))
  ])
  // ls-tree: "<mode> blob <oid>"; ls-files: "<mode> <oid> <stage>".
  const wanted = parseEntries(tree.stdout, (header) => {
    const [mode, type, oid] = header.split(' ')
    return type === 'blob' && REGULAR_FILE_MODES.has(mode) ? `${mode} ${oid}` : null
  })
  const checkedOut = parseEntries(index.stdout, (header) => {
    const [mode, oid, stage] = header.split(' ')
    return stage === '0' ? `${mode} ${oid}` : null
  })
  return [...wanted].filter(([path, key]) => checkedOut.get(path) === key).map(([path]) => path)
}

/** Drops files whose checkout applies a filter (e.g. Git LFS); Git writes those itself. */
async function withoutCheckoutConversion(
  worktreePath: string,
  paths: string[],
  options: GitWorktreeExecOptions
): Promise<string[]> {
  // --cached reads the attributes of the base commit that read-tree just staged.
  const { stdout } = await gitExecFileAsync(
    ['check-attr', '--cached', '-z', '--stdin', ...CHECKOUT_CONVERSION_ATTRIBUTES],
    {
      ...gitExecOptions(worktreePath, options),
      maxBuffer: LIST_MAX_BUFFER,
      stdin: paths.join('\0')
    }
  )
  // -z output: "<path>\0<attribute>\0<value>\0" per path and attribute.
  const converted = new Set<string>()
  const fields = stdout.split('\0')
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] !== 'unspecified' && fields[i + 2] !== 'unset') {
      converted.add(fields[i])
    }
  }
  return paths.filter((path) => !converted.has(path))
}

async function runClone(
  method: CloneMethod,
  sources: string[],
  targetDirectory: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  const [file, args] =
    method === 'apfs'
      ? ['/bin/cp', ['-c', ...sources, targetDirectory]]
      : ['cp', ['--reflink=always', '-t', targetDirectory, ...sources]]
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
    await mkdir(targetDirectory, { recursive: true })
    for (let i = 0; i < sources.length; i += CLONE_BATCH_SIZE) {
      batches.push({ targetDirectory, sources: sources.slice(i, i + CLONE_BATCH_SIZE) })
    }
  }
  // Probe with one file: an unsupported filesystem fails here, before any batch runs.
  const [first] = batches
  await runClone(method, first.sources.slice(0, 1), first.targetDirectory, options)
  first.sources = first.sources.slice(1)
  let next = 0
  const workers = Array.from({ length: Math.min(CLONE_CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) {
      options.signal?.throwIfAborted()
      const batch = batches[next++]
      if (batch.sources.length > 0) {
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
    if (candidates.length === 0) {
      return
    }
    await readTreeIntoPlainIndex(worktreePath, commit, options)
    const paths = await withoutCheckoutConversion(worktreePath, candidates, options)
    if (paths.length === 0) {
      return
    }
    await cloneFiles(method, repoPath, worktreePath, paths, options)
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
