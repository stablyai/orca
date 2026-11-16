// The cloud half of a sync pass, over the workspace's E2EE orcad connection: walk `.context`,
// stat it in batches, and page files down. Replies are validated, never
// trusted: the VM is not this process.
import { z } from 'zod'
import { FILE_STAT_MANY_MAX } from '../../shared/file-access/file-stat-many'
import { CONTEXT_DIR, isSafeSyncPath } from './cloud-sync-paths'
import type { RemoteEntry } from './cloud-sync-plan'

export type SyncCall = <T = unknown>(
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<T>

const LIST_TIMEOUT_MS = 60_000
const STAT_TIMEOUT_MS = 60_000
const FALLBACK_STAT_CONCURRENCY = 12
const CONTEXT_MAX_DEPTH = 8

export class SyncRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string = code
  ) {
    super(message)
    this.name = 'SyncRemoteError'
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|not.?found|no such/i.test(message)
}

/** Transport answers for a sandbox that is asleep, waking or unreachable right now. */
const WAITING_CODES = new Set([
  'runtime_environment_asleep',
  'runtime_environment_waking',
  'runtime_environment_wake_failed',
  'remote_runtime_unavailable',
  'runtime_unavailable'
])

/** Not a failure: the next wake starts a fresh session. */
export function isWaitingError(error: unknown): boolean {
  return WAITING_CODES.has(errorCode(error) ?? '')
}

/** Transport and orcad errors carry a string `code`. */
const CodedError = z.looseObject({ code: z.string() })

export function errorCode(error: unknown): string | null {
  const parsed = CodedError.safeParse(error)
  return parsed.success ? parsed.data.code : null
}

const WorktreeRows = z.looseObject({
  worktrees: z
    .array(z.looseObject({ id: z.unknown(), path: z.unknown() }))
    .optional()
    .catch(undefined)
})
const DirEntries = z.array(
  z.looseObject({ name: z.string(), isDirectory: z.boolean(), isSymlink: z.boolean().optional() })
)
const StatMany = z.object({
  entries: z.array(
    z.union([
      z.null(),
      z.object({
        size: z.number().nonnegative(),
        mtime: z.number(),
        type: z.enum(['file', 'directory', 'symlink'])
      }),
      z.object({ error: z.string() })
    ])
  )
})
const SingleStat = z.looseObject({
  size: z.number().nonnegative(),
  mtime: z.number(),
  isDirectory: z.boolean()
})

/** The orcad worktree for this workspace: its selector and its absolute path in the VM. */
export async function resolveCloudWorktree(
  call: SyncCall,
  workspaceId: string,
  projectRoot: string | null
): Promise<{ selector: string; root: string }> {
  const rows = WorktreeRows.parse(await call('worktree.list', {}, { timeoutMs: LIST_TIMEOUT_MS }))
  const valid = (rows.worktrees ?? []).filter(
    (row): row is { id: string; path: string } =>
      typeof row.id === 'string' && typeof row.path === 'string'
  )
  const found =
    valid.find((row) => row.id === workspaceId || row.id.endsWith(`::${workspaceId}`)) ??
    valid.find((row) => projectRoot !== null && row.path === projectRoot) ??
    (valid.length === 1 ? valid[0] : undefined)
  if (!found) {
    throw new SyncRemoteError('worktree_not_found')
  }
  return { selector: `id:${found.id}`, root: found.path.replace(/\/+$/, '') }
}

/** Every regular file under `.context` (it is usually gitignored, so it is walked, not listed). */
export async function listContext(
  call: SyncCall,
  selector: string,
  maxFiles: number,
  signal?: AbortSignal
): Promise<{ paths: string[]; truncated: boolean }> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > CONTEXT_MAX_DEPTH || out.length >= maxFiles) {
      return
    }
    let entries: z.infer<typeof DirEntries>
    try {
      entries = DirEntries.parse(
        await call(
          'files.readDir',
          { worktree: selector, relativePath: dir },
          { timeoutMs: LIST_TIMEOUT_MS, signal }
        )
      )
    } catch (error) {
      // No .context folder is the common case, not a failure.
      if (depth === 0 && isNotFound(error)) {
        return
      }
      throw error
    }
    for (const entry of entries) {
      if (entry.isSymlink) {
        continue
      }
      const child = `${dir}/${entry.name}`
      if (!isSafeSyncPath(child)) {
        continue
      }
      if (entry.isDirectory) {
        await walk(child, depth + 1)
      } else if (out.length < maxFiles) {
        out.push(child)
      }
    }
  }
  await walk(CONTEXT_DIR, 0)
  return { paths: out, truncated: out.length >= maxFiles }
}

/** Hosts whose orcad predates `files.statMany` (an older sandbox image). */
const statManyUnsupported = new WeakMap<SyncCall, true>()

/** Size and mtime of regular files; absent paths, directories and symlinks are left out. */
export async function statFiles(
  call: SyncCall,
  selector: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, RemoteEntry>> {
  const out = new Map<string, RemoteEntry>()
  for (let i = 0; i < paths.length; i += FILE_STAT_MANY_MAX) {
    const batch = paths.slice(i, i + FILE_STAT_MANY_MAX)
    if (!statManyUnsupported.has(call)) {
      try {
        const reply = StatMany.parse(
          await call(
            'files.statMany',
            { worktree: selector, relativePaths: batch },
            { timeoutMs: STAT_TIMEOUT_MS, signal }
          )
        )
        if (reply.entries.length !== batch.length) {
          throw new SyncRemoteError('bad_reply')
        }
        reply.entries.forEach((entry, index) => {
          if (entry && 'type' in entry && entry.type === 'file') {
            out.set(batch[index]!, { size: entry.size, mtime: entry.mtime })
          }
        })
        continue
      } catch (error) {
        if (errorCode(error) !== 'method_not_found') {
          throw error
        }
        statManyUnsupported.set(call, true)
      }
    }
    await statOneByOne(call, selector, batch, out, signal)
  }
  return out
}

async function statOneByOne(
  call: SyncCall,
  selector: string,
  batch: readonly string[],
  out: Map<string, RemoteEntry>,
  signal?: AbortSignal
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const path = batch[next++]!
      try {
        const stat = SingleStat.parse(
          await call(
            'files.stat',
            { worktree: selector, relativePath: path },
            { timeoutMs: STAT_TIMEOUT_MS, signal }
          )
        )
        if (!stat.isDirectory) {
          out.set(path, { size: stat.size, mtime: stat.mtime })
        }
      } catch (error) {
        // Deleted between listing and stat: simply not in the manifest.
        if (!isNotFound(error)) {
          throw error
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FALLBACK_STAT_CONCURRENCY, batch.length) }, worker)
  )
}

/** Maps a watch event's absolute VM path to a workspace-relative one (null when outside it). */
export function relativeToRoot(root: string, absolutePath: unknown): string | null {
  if (typeof absolutePath !== 'string') {
    return null
  }
  const prefix = `${root}/`
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : null
}
