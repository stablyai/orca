import { lstat, mkdir, unlink } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { dirname, join } from 'node:path'
import {
  forEachWithConcurrency,
  mapWithConcurrency
} from '../../../../shared/concurrency/map-with-concurrency'
import { canCloneWithApfs } from '../../../ipc/worktrees/linked-paths/worktree-apfs-clone'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'

const BATCH_SIZE = 256
// APFS cloning scales to about four parallel streams and slows beyond that.
const PROCESS_CONCURRENCY = 4
const FILE_CONCURRENCY = 64
const MAX_BUFFER = 256 * 1024 * 1024
const CONVERSION_ATTRIBUTES = ['eol', 'filter', 'ident', 'working-tree-encoding']

type TrackedFile = { path: string; oid: string; executable: boolean }

type CloneContext = { repoPath: string; worktreePath: string; options: GitWorktreeExecOptions }

/**
 * Fills a `--no-checkout` worktree with APFS clones of the repo's files that are byte-identical
 * to the commit. The caller's `reset --hard` writes everything this leaves absent or unverified.
 */
export async function cloneWorktreeCheckoutFiles(
  args: CloneContext & { commit: string }
): Promise<void> {
  const { commit, ...context } = args
  const { options } = context
  if (!options.copyOnWriteCheckout || process.platform !== 'darwin' || options.wslDistro) {
    return
  }
  try {
    if (!(await canCloneWithApfs(context.repoPath, context.worktreePath))) {
      return
    }
    if (await configConvertsCheckout(context)) {
      return
    }
    await runGit(context, ['read-tree', commit])
    const files = await withoutConvertedFiles(context, await listTrackedFiles(context))
    await cloneFiles(context, files)
    // Clones keep the repo's xattrs (quarantine); a checkout has none.
    await runTool(context, '/usr/bin/xattr', ['-cr', context.worktreePath])
    await removeMismatchedClones(context, files)
    // Why fsmonitor off: a stale daemon answer would mark unverified files as clean.
    await runGit(context, ['-c', 'core.fsmonitor=false', 'update-index', '-q', '--refresh'])
  } catch (error) {
    options.signal?.throwIfAborted()
    // Index entries without stat data make the reset rewrite every file left here.
    console.warn(`[git/worktree] Checkout clone failed for ${context.worktreePath}:`, error)
  }
}

function runGit(
  context: CloneContext,
  args: string[],
  stdin?: string
): Promise<{ stdout: string }> {
  return gitExecFileAsync(args, {
    ...gitExecOptions(context.worktreePath, context.options),
    admissionClass: 'checkout',
    maxBuffer: MAX_BUFFER,
    timeout: resolveWorktreeAddTimeoutMs(),
    ...(stdin === undefined ? {} : { stdin })
  })
}

async function runTool(context: CloneContext, binary: string, args: string[]): Promise<void> {
  const { options } = context
  if (options.canStart?.() === false) {
    throw new Error('Checkout preparation is no longer current')
  }
  let reportTerminated: () => void = () => {}
  // Discarding the checkout must wait for a child still writing inside it.
  options.observeChildTermination?.(
    new Promise<void>((resolve) => {
      reportTerminated = resolve
    }),
    true
  )
  const result = await runProcess({
    program: binary,
    args,
    cwd: context.worktreePath,
    timeoutMs: resolveWorktreeAddTimeoutMs(),
    onChildTerminated: reportTerminated,
    ...(options.signal ? { signal: options.signal } : {})
  })
  options.signal?.throwIfAborted()
  if (result.code !== 0) {
    throw new Error(
      `${binary} exited with ${result.code ?? result.signal}: ${result.stderr.trim()}`
    )
  }
}

async function configConvertsCheckout(context: CloneContext): Promise<boolean> {
  const read = (key: string): Promise<string> =>
    // bool-or-str makes a bare key read as true, as Git treats it.
    runGit(context, ['config', '--type=bool-or-str', '--default=', '--get', key]).then(
      ({ stdout }) => stdout.trim().toLowerCase()
    )
  const [autocrlf, eol, sparse] = await Promise.all([
    read('core.autocrlf'),
    read('core.eol'),
    read('core.sparseCheckout')
  ])
  return autocrlf === 'true' || eol === 'crlf' || sparse === 'true'
}

async function listTrackedFiles(context: CloneContext): Promise<TrackedFile[]> {
  const { stdout } = await runGit(context, ['ls-files', '--stage', '-z'])
  const files: TrackedFile[] = []
  for (const entry of stdout.split('\0')) {
    const match = /^(100644|100755) ([0-9a-f]+) 0\t(.+)$/su.exec(entry)
    // hash-object --stdin-paths is line-based and unquotes a leading double quote.
    if (match && !match[3].startsWith('"') && !/[\n\r]/u.test(match[3])) {
      files.push({ executable: match[1] === '100755', oid: match[2], path: match[3] })
    }
  }
  return files
}

/** A clone only equals a checkout when Git writes the blob unconverted. */
async function withoutConvertedFiles(
  context: CloneContext,
  files: TrackedFile[]
): Promise<TrackedFile[]> {
  if (files.length === 0) {
    return files
  }
  const { stdout } = await runGit(
    context,
    ['check-attr', '--cached', '-z', '--stdin', ...CONVERSION_ATTRIBUTES],
    `${files.map((file) => file.path).join('\0')}\0`
  )
  const fields = stdout.split('\0')
  const converted = new Set<string>()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3)
    if (value !== 'unspecified' && value !== 'unset' && !(attribute === 'eol' && value === 'lf')) {
      converted.add(path)
    }
  }
  return files.filter((file) => !converted.has(file.path))
}

function batches<T>(items: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    result.push(items.slice(index, index + BATCH_SIZE))
  }
  return result
}

async function cloneFiles(context: CloneContext, files: readonly TrackedFile[]): Promise<void> {
  const byDirectory = new Map<string, TrackedFile[]>()
  for (const file of files) {
    const directory = dirname(file.path)
    const siblings = byDirectory.get(directory)
    if (siblings) {
      siblings.push(file)
    } else {
      byDirectory.set(directory, [file])
    }
  }
  const work = [...byDirectory].flatMap(([directory, siblings]) =>
    batches(siblings).map((batch) => ({ directory, batch }))
  )
  await forEachWithConcurrency(work, PROCESS_CONCURRENCY, async ({ directory, batch }) => {
    const target = join(context.worktreePath, directory)
    try {
      await mkdir(target, { recursive: true })
      // Failed sources are simply absent afterwards, so Git writes them.
      await runTool(context, '/bin/cp', [
        '-c',
        ...batch.map((file) => join(context.repoPath, file.path)),
        `${target}/`
      ]).catch(() => {})
      // Clones keep the repo's BSD flags; a locked clone would refuse the chmod below.
      await runTool(context, '/usr/bin/chflags', [
        'nouchg,nouappnd',
        ...batch.map((file) => join(context.worktreePath, file.path))
      ]).catch(() => {})
      for (const executable of [false, true]) {
        const paths = batch
          .filter((file) => file.executable === executable)
          .map((file) => join(context.worktreePath, file.path))
        if (paths.length > 0) {
          // Clones keep the repo's modes; chmod without a who applies the umask, as Git does.
          const mode = executable ? '=rwx' : '=rw'
          await runTool(context, '/bin/chmod', [mode, ...paths]).catch(() =>
            // Git only compares the execute bit, so a wrong mode must not survive as a clone.
            forEachWithConcurrency(paths, FILE_CONCURRENCY, (path) => unlink(path).catch(() => {}))
          )
        }
      }
    } catch (error) {
      context.options.signal?.throwIfAborted()
      console.warn('[git/worktree] Could not clone checkout files:', error)
    }
  })
}

/** Deletes clones that are not the commit's bytes exactly, so the reset writes them. */
async function removeMismatchedClones(
  context: CloneContext,
  files: readonly TrackedFile[]
): Promise<void> {
  const present = (
    await mapWithConcurrency(files, FILE_CONCURRENCY, async (file) =>
      (await lstat(join(context.worktreePath, file.path)).catch(() => null))?.isFile() ? file : null
    )
  ).filter((file): file is TrackedFile => file !== null)
  if (present.length === 0) {
    return
  }
  // hash-object hashes on one core; split the list so hashing uses several.
  const chunkSize = Math.ceil(present.length / PROCESS_CONCURRENCY)
  const chunks: TrackedFile[][] = []
  for (let index = 0; index < present.length; index += chunkSize) {
    chunks.push(present.slice(index, index + chunkSize))
  }
  const mismatched = (
    await Promise.all(
      chunks.map(async (chunk) => {
        const { stdout } = await runGit(
          context,
          ['hash-object', '--no-filters', '--stdin-paths'],
          `${chunk.map((file) => file.path).join('\n')}\n`
        )
        const hashes = stdout.trim().split('\n')
        if (hashes.length !== chunk.length) {
          throw new Error(`Expected ${chunk.length} clone hashes, received ${hashes.length}`)
        }
        return chunk.filter((file, index) => hashes[index] !== file.oid)
      })
    )
  ).flat()
  await forEachWithConcurrency(mismatched, FILE_CONCURRENCY, (file) =>
    unlink(join(context.worktreePath, file.path))
  )
}
