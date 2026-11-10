import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { withFileTransactionLock } from '../../../filesystem/file-transaction-lock'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-identity'
import { isWslUncPath } from '../../../../shared/wsl-paths'

const mutations = new Map<string, Promise<unknown>>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCodexSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function recordsDir(): string {
  return join(getOrcaUserDataPath(), 'codex-session-deletions')
}

function recordPath(
  sessionId: string,
  suffix: 'tombstone' | 'pending' | 'complete' = 'tombstone'
): string {
  if (!isCodexSessionUuid(sessionId)) {
    throw new Error('Invalid Codex session UUID')
  }
  return join(recordsDir(), `${sessionId.toLowerCase()}.${suffix}`)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function isCodexSessionDeletionRecorded(
  sessionId: unknown,
  complete = false
): Promise<boolean> {
  if (!isCodexSessionUuid(sessionId)) {
    return false
  }
  return complete
    ? recordExists(sessionId, 'complete')
    : (await recordExists(sessionId, 'tombstone')) || recordExists(sessionId, 'pending')
}

async function recordExists(
  sessionId: string,
  suffix: 'tombstone' | 'pending' | 'complete'
): Promise<boolean> {
  try {
    await lstat(recordPath(sessionId, suffix))
    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

async function writeRecordAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 })
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export async function recordCodexSessionDeletion(
  sessionId: string,
  complete = false,
  homes: readonly string[] = []
): Promise<void> {
  const path = recordPath(sessionId, complete ? 'complete' : 'pending')
  await mkdir(recordsDir(), { recursive: true, mode: 0o700 })
  await writeRecordAtomically(recordPath(sessionId), '{}')
  await writeRecordAtomically(path, JSON.stringify({ homes }))
  if (complete) {
    try {
      await unlink(recordPath(sessionId, 'pending'))
    } catch (error) {
      if (!isNotFound(error)) {
        throw error
      }
    }
  }
}

export async function pendingCodexSessionDeletionHomes(sessionId: string): Promise<string[]> {
  let contents: string
  try {
    contents = await readFile(recordPath(sessionId, 'pending'), 'utf8')
  } catch (error) {
    if (isNotFound(error)) {
      return []
    }
    throw error
  }
  const record: unknown = JSON.parse(contents)
  if (
    !record ||
    typeof record !== 'object' ||
    !('homes' in record) ||
    !Array.isArray(record.homes) ||
    !record.homes.every((home): home is string => typeof home === 'string')
  ) {
    throw new Error('Invalid Codex session deletion record')
  }
  return record.homes
}

export async function isCodexRolloutDeletionRecorded(
  filePath: string,
  complete = false
): Promise<boolean> {
  if (isWslUncPath(filePath)) {
    return false
  }
  const rollout = parseCodexRolloutThreadId(filePath)
  return rollout !== null && isCodexSessionDeletionRecorded(rollout.threadId, complete)
}

export async function createCodexRolloutVisibilityPredicate(
  options: { includePending?: boolean } = {}
): Promise<(filePath: string) => boolean> {
  let entries: string[]
  try {
    entries = await readdir(recordsDir())
  } catch (error) {
    if (!isNotFound(error)) {
      throw error
    }
    entries = []
  }
  const suffixes = options.includePending ? ['complete', 'pending', 'tombstone'] : ['complete']
  const recorded = new Set(
    entries
      .filter((entry) => suffixes.includes(entry.slice(entry.lastIndexOf('.') + 1)))
      .map((entry) => entry.slice(0, entry.lastIndexOf('.')).toLowerCase())
      .filter(isCodexSessionUuid)
  )
  return (filePath) => {
    if (isWslUncPath(filePath)) {
      return true
    }
    const rollout = parseCodexRolloutThreadId(filePath)
    return rollout === null || !recorded.has(rollout.threadId)
  }
}

export async function withCodexSessionHistoryMutation<T>(
  sessionId: string,
  operation: () => Promise<T>,
  options: { onBusy?: () => T } = {}
): Promise<T> {
  const key = sessionId.toLowerCase()
  const previous = mutations.get(key)
  if (previous && options.onBusy) {
    return options.onBusy()
  }
  const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    isCodexSessionUuid(sessionId)
      ? withFileTransactionLock(recordPath(sessionId), operation, {
          retries: options.onBusy ? 0 : undefined
        })
      : operation()
  )
  mutations.set(key, task)
  try {
    return await task
  } catch (error) {
    if (options.onBusy && error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
      return options.onBusy()
    }
    throw error
  } finally {
    if (mutations.get(key) === task) {
      mutations.delete(key)
    }
  }
}

/** Resolves to null when another history mutation holds this session, so the caller can defer. */
export function readUnlessCodexSessionDeleted<T>(
  sessionId: string,
  deletedOutcome: T,
  read: () => Promise<T>
): Promise<T | null> {
  return withCodexSessionHistoryMutation<T | null>(
    sessionId,
    async () => ((await isCodexSessionDeletionRecorded(sessionId)) ? deletedOutcome : read()),
    { onBusy: () => null }
  )
}

export async function withCodexRolloutPublication<T>(
  filePath: string,
  skipped: T,
  publish: () => Promise<T>
): Promise<T> {
  const rollout = parseCodexRolloutThreadId(filePath)
  if (!rollout || isWslUncPath(filePath)) {
    return publish()
  }
  if (await isCodexSessionDeletionRecorded(rollout.threadId)) {
    return skipped
  }
  const path = recordPath(rollout.threadId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let release: () => Promise<void>
  try {
    release = await lock(path, { realpath: false, retries: 0 })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
      return skipped
    }
    throw error
  }
  try {
    return (await isCodexSessionDeletionRecorded(rollout.threadId)) ? skipped : await publish()
  } finally {
    await release()
  }
}
