import { createHash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type {
  CursorSidecarScanRequest,
  CursorSidecarScanResponse
} from '../shared/cursor-sidecar-scan'
import type { RequestContext } from './dispatcher'

const BUCKET_PATTERN = /^[0-9a-f]{32}$/u
const BUCKET_READ_CONCURRENCY = 8

export type CursorSidecarScanCaps = {
  buckets: number
  sessions: number
  scopes: number
  sidecarBytes: number
  aggregateBytes: number
}

type Bucket = { name: string; path: string; scopeCwd: string | null }

export type CursorSidecarScanCandidate = Bucket & {
  sessionId: string
  metaPath: string
  meta: Stats
  store: Stats
}

export async function discoverCursorSidecarCandidates(args: {
  request: CursorSidecarScanRequest
  caps: CursorSidecarScanCaps
  response: CursorSidecarScanResponse
  context: RequestContext
}): Promise<{ rootRealPath: string; candidates: CursorSidecarScanCandidate[] } | null> {
  const chatsRoot = args.request.chatsRoot
  let rootRealPath: string
  let rootEntries: Dirent[]
  try {
    rootRealPath = await realpath(chatsRoot)
    args.response.counters.rootReaddir++
    rootEntries = await readdir(chatsRoot, { withFileTypes: true })
  } catch (error) {
    if (!isMissing(error)) {
      addIssue(args.response, chatsRoot, error)
    }
    return null
  }
  throwIfCancelled(args.context)

  const direct = await scopeBuckets(args.request, chatsRoot, args)
  const enumerated = enumeratedBuckets(rootEntries, chatsRoot, direct, args)
  const sessions = await retainSessions([...direct.values(), ...enumerated], args)
  const candidates = await eligibleCandidates(sessions, args)
  return { rootRealPath, candidates }
}

async function scopeBuckets(
  request: CursorSidecarScanRequest,
  chatsRoot: string,
  args: {
    caps: CursorSidecarScanCaps
    response: CursorSidecarScanResponse
    context: RequestContext
  }
): Promise<Map<string, Bucket>> {
  const paths = [...new Set(request.scopePaths.map((value) => value.trim()).filter(Boolean))].sort()
  args.response.truncated.scopePaths = paths.length > args.caps.scopes
  const cwds = new Set<string>()
  for (const scopePath of paths.slice(0, args.caps.scopes)) {
    for (const cwd of targetPathVariants(scopePath)) {
      cwds.add(cwd)
    }
    try {
      args.response.counters.scopeRealpath++
      const resolved = await realpath(scopePath)
      for (const cwd of targetPathVariants(resolved)) {
        cwds.add(cwd)
      }
    } catch {
      // Scope paths are allowed to be absent on the owning host.
    }
    throwIfCancelled(args.context)
  }
  const buckets = new Map<string, Bucket>()
  args.response.scopeCwds = [...cwds].sort()
  for (const cwd of args.response.scopeCwds) {
    // Cursor names its bucket dirs md5(cwd); this mirrors that, not a security primitive.
    const name = createHash('md5').update(cwd).digest('hex')
    buckets.set(name, { name, path: join(chatsRoot, name), scopeCwd: cwd })
  }
  return buckets
}

function enumeratedBuckets(
  entries: readonly Dirent[],
  chatsRoot: string,
  direct: ReadonlyMap<string, Bucket>,
  args: { caps: CursorSidecarScanCaps; response: CursorSidecarScanResponse }
): Bucket[] {
  const retained = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        BUCKET_PATTERN.test(entry.name) &&
        !direct.has(entry.name)
    )
    .sort((left, right) => left.name.localeCompare(right.name))
  args.response.truncated.buckets = retained.length > args.caps.buckets
  return retained.slice(0, args.caps.buckets).map((entry) => ({
    name: entry.name,
    path: join(chatsRoot, entry.name),
    scopeCwd: null
  }))
}

async function retainSessions(
  buckets: readonly Bucket[],
  args: {
    caps: CursorSidecarScanCaps
    response: CursorSidecarScanResponse
    context: RequestContext
  }
): Promise<(Bucket & { sessionId: string })[]> {
  const retained: (Bucket & { sessionId: string })[] = []
  for (
    let index = 0;
    index < buckets.length && retained.length < args.caps.sessions;
    index += BUCKET_READ_CONCURRENCY
  ) {
    const batch = buckets.slice(index, index + BUCKET_READ_CONCURRENCY)
    const listings = await Promise.all(
      batch.map(async (bucket) => {
        try {
          if (bucket.scopeCwd) {
            const stats = await lstat(bucket.path)
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
              return { bucket, entries: [] as Dirent[] }
            }
          }
          args.response.counters.bucketReaddir++
          return {
            bucket,
            entries: await readdir(bucket.path, { withFileTypes: true })
          }
        } catch (error) {
          if (!isMissing(error)) {
            addIssue(args.response, bucket.path, error)
          }
          return { bucket, entries: [] as Dirent[] }
        }
      })
    )
    throwIfCancelled(args.context)
    const batchSessions = listings.flatMap(({ bucket, entries }) =>
      entries
        .filter(
          (entry) => entry.isDirectory() && !entry.isSymbolicLink() && safeBasename(entry.name)
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ ...bucket, sessionId: entry.name }))
    )
    const capacity = args.caps.sessions - retained.length
    retained.push(...batchSessions.slice(0, capacity))
    if (batchSessions.length > capacity || index + batch.length < buckets.length) {
      args.response.truncated.sessionDirs = retained.length >= args.caps.sessions
    }
    if (retained.length >= args.caps.sessions) {
      break
    }
  }
  return retained
}

async function eligibleCandidates(
  sessions: readonly (Bucket & { sessionId: string })[],
  args: {
    caps: CursorSidecarScanCaps
    response: CursorSidecarScanResponse
    context: RequestContext
  }
): Promise<CursorSidecarScanCandidate[]> {
  const candidates: CursorSidecarScanCandidate[] = []
  for (let index = 0; index < sessions.length; index += BUCKET_READ_CONCURRENCY) {
    const batch = sessions.slice(index, index + BUCKET_READ_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (session): Promise<CursorSidecarScanCandidate | null> => {
        const sessionDir = join(session.path, session.sessionId)
        const metaPath = join(sessionDir, 'meta.json')
        try {
          args.response.counters.fileLstat += 2
          const [meta, store] = await Promise.all([
            lstat(metaPath),
            lstat(join(sessionDir, 'store.db'))
          ])
          if (
            !meta.isFile() ||
            meta.isSymbolicLink() ||
            !store.isFile() ||
            store.isSymbolicLink()
          ) {
            return null
          }
          if (meta.size > args.caps.sidecarBytes) {
            addIssue(
              args.response,
              metaPath,
              new Error('Cursor session metadata exceeds the read limit.')
            )
            return null
          }
          return { ...session, metaPath, meta, store }
        } catch (error) {
          if (!isMissing(error)) {
            addIssue(args.response, metaPath, error)
          }
          return null
        }
      })
    )
    throwIfCancelled(args.context)
    candidates.push(
      ...results.filter((result): result is CursorSidecarScanCandidate => Boolean(result))
    )
  }
  return candidates.sort(
    (left, right) =>
      Number(right.scopeCwd !== null) - Number(left.scopeCwd !== null) ||
      Math.max(right.meta.mtimeMs, right.store.mtimeMs) -
        Math.max(left.meta.mtimeMs, left.store.mtimeMs) ||
      `${left.name}\0${left.sessionId}`.localeCompare(`${right.name}\0${right.sessionId}`)
  )
}

function targetPathVariants(value: string): string[] {
  const pathOps = process.platform === 'win32' ? win32 : posix
  if (!pathOps.isAbsolute(value)) {
    return []
  }
  const resolved = pathOps.resolve(value)
  if (process.platform !== 'win32') {
    return [resolved]
  }
  const match = /^([A-Za-z]):/u.exec(resolved)
  return match
    ? [
        ...new Set([
          resolved,
          `${match[1].toUpperCase()}${resolved.slice(1)}`,
          `${match[1].toLowerCase()}${resolved.slice(1)}`
        ])
      ]
    : [resolved]
}

function safeBasename(value: string): boolean {
  return Boolean(value && value !== '.' && value !== '..' && !/[\\/]/u.test(value))
}

function addIssue(response: CursorSidecarScanResponse, path: string, error: unknown): void {
  response.issues.push({
    path,
    message: error instanceof Error ? error.message.slice(0, 1_024) : 'Cursor scan failed.'
  })
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function throwIfCancelled(context: RequestContext): void {
  if (context.isStale() || context.signal?.aborted) {
    throw new Error('cursor_sidecar_scan_cancelled')
  }
}
