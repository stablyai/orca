import { lstatSync, readdirSync } from 'node:fs'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { yieldToEventLoop } from '../../shared/event-loop-yield'

// Same dated rollout shape as claimsCodexRolloutLayout. Kept here so the CLI can run retention
// without importing the resume module's desktop-only graph.
const PRIVATE_CODEX_ROLLOUT_LAYOUT =
  /(?:^|\/)sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl(?:\.zst)?$/i

export function isPrivateCodexRolloutPath(filePath: string): boolean {
  return PRIVATE_CODEX_ROLLOUT_LAYOUT.test(filePath.replace(/\\/g, '/'))
}

export const DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS = 30
export const MS_PER_DAY = 24 * 60 * 60 * 1000
export const DEFAULT_CODEX_SESSION_MAX_AGE_MS = DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS * MS_PER_DAY
/** A few gigabytes: heavy orchestration must not keep every rollout forever. */
export const DEFAULT_CODEX_SESSION_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** Size-cap deletions never touch a rollout still inside this window. */
export const CODEX_SESSION_SIZE_CAP_MIN_KEEP_MS = MS_PER_DAY

const WALK_YIELD_EVERY = 64

export type CodexSessionRetentionPolicy = {
  now: number
  maxAgeMs: number
  maxBytes: number
  minKeepMs: number
}

export type CodexSessionTreeSnapshot = {
  totalBytes: number
  rolloutFiles: number
  rollouts: CodexSessionRollout[]
}

export type CodexSessionRollout = {
  path: string
  bytes: number
  mtimeMs: number
}

export type CodexSessionRetentionResult = {
  sessionsDir: string
  scannedBytes: number
  removedFiles: number
  removedBytes: number
  keptFiles: number
  keptBytes: number
  remainingOverCapBytes: number
}

export function defaultCodexSessionRetentionPolicy(now = Date.now()): CodexSessionRetentionPolicy {
  return {
    now,
    maxAgeMs: DEFAULT_CODEX_SESSION_MAX_AGE_MS,
    maxBytes: DEFAULT_CODEX_SESSION_MAX_BYTES,
    minKeepMs: CODEX_SESSION_SIZE_CAP_MIN_KEEP_MS
  }
}

export function listPrivateCodexSessionRoots(userDataPath: string): string[] {
  const roots: string[] = []
  const shared = join(userDataPath, 'codex-runtime-home', 'home', 'sessions')
  if (isRealDirectorySync(shared)) {
    roots.push(shared)
  }
  const accounts = join(userDataPath, 'codex-accounts')
  if (!isRealDirectorySync(accounts)) {
    return roots
  }
  for (const entry of readdirSync(accounts, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue
    }
    const sessions = join(accounts, entry.name, 'home', 'sessions')
    if (isRealDirectorySync(sessions)) {
      roots.push(sessions)
    }
  }
  return roots
}

function isRealDirectorySync(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

export function selectCodexRolloutsToRemove(
  rollouts: readonly CodexSessionRollout[],
  policy: CodexSessionRetentionPolicy
): { remove: CodexSessionRollout[]; kept: CodexSessionRollout[]; keptBytes: number } {
  const remove: CodexSessionRollout[] = []
  const survivors: CodexSessionRollout[] = []
  for (const rollout of rollouts) {
    if (policy.now - rollout.mtimeMs >= policy.maxAgeMs) {
      remove.push(rollout)
    } else {
      survivors.push(rollout)
    }
  }
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs)
  let keptBytes = 0
  for (const rollout of survivors) {
    keptBytes += rollout.bytes
  }
  const kept: CodexSessionRollout[] = []
  for (const rollout of survivors) {
    const protectedRecent = policy.now - rollout.mtimeMs < policy.minKeepMs
    if (keptBytes > policy.maxBytes && !protectedRecent) {
      remove.push(rollout)
      keptBytes -= rollout.bytes
      continue
    }
    kept.push(rollout)
  }
  return { remove, kept, keptBytes }
}

export async function snapshotCodexSessionTree(
  sessionsDir: string
): Promise<CodexSessionTreeSnapshot> {
  const rollouts: CodexSessionRollout[] = []
  let totalBytes = 0
  let visited = 0
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited += 1
      if (visited % WALK_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      if (entry.isSymbolicLink()) {
        continue
      }
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(child)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      let info
      try {
        info = await lstat(child)
      } catch {
        continue
      }
      if (!info.isFile()) {
        continue
      }
      totalBytes += info.size
      if (isPrivateCodexRolloutPath(child)) {
        rollouts.push({ path: child, bytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  await visit(sessionsDir)
  return { totalBytes, rolloutFiles: rollouts.length, rollouts }
}

export async function applyCodexSessionRetention(args: {
  sessionsDir: string
  policy?: CodexSessionRetentionPolicy
  dryRun?: boolean
}): Promise<CodexSessionRetentionResult> {
  const policy = args.policy ?? defaultCodexSessionRetentionPolicy()
  const snapshot = await snapshotCodexSessionTree(args.sessionsDir)
  const selected = selectCodexRolloutsToRemove(snapshot.rollouts, policy)
  if (!args.dryRun) {
    for (const rollout of selected.remove) {
      await removeRolloutFile(args.sessionsDir, rollout.path)
    }
  }
  return {
    sessionsDir: args.sessionsDir,
    scannedBytes: snapshot.totalBytes,
    removedFiles: selected.remove.length,
    removedBytes: selected.remove.reduce((sum, rollout) => sum + rollout.bytes, 0),
    keptFiles: selected.kept.length,
    keptBytes: selected.keptBytes,
    remainingOverCapBytes: Math.max(0, selected.keptBytes - policy.maxBytes)
  }
}

async function removeRolloutFile(sessionsDir: string, filePath: string): Promise<void> {
  const rel = relative(sessionsDir, filePath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return
  }
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isMissing(error)) {
      console.warn(
        `[session-retention] Failed to remove Codex rollout: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return
  }
  await removeEmptyParents(sessionsDir, dirname(filePath))
}

async function removeEmptyParents(sessionsDir: string, startDir: string): Promise<void> {
  let dir = startDir
  while (true) {
    const rel = relative(sessionsDir, dir)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return
    }
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
