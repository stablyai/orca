// The capsule's file: bounded reads, and durable replace-on-write so a crash leaves the old or the new file.

import { rm } from 'node:fs/promises'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../../../shared/json-stream/node-bounded-json-stringify'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeTempFileDurable
} from '../../../filesystem/durable-file-write'
import {
  storedAgentSessionResumeMarker,
  type AgentSessionResumeMarker
} from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { withFileTransactionLock } from '../../../filesystem/file-transaction-lock'
import {
  normalizeState,
  parseState,
  type RecoveryCapsuleState
} from './agent-session-recovery-capsule-entries'

const MAX_CAPSULE_BYTES = 4 * 1024 * 1024

/** Crash-leftover temp files only; offers themselves have no expiry. */
const STALE_WRITE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1000

export async function readRecoveryCapsuleState(filePath: string): Promise<RecoveryCapsuleState> {
  let raw: string
  try {
    raw = (await readNodeFileWithinLimit(filePath, MAX_CAPSULE_BYTES)).buffer.toString('utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { entries: [], failed: [] }
    }
    throw error
  }
  return parseState(raw)
}

export async function writeRecoveryFileDurable(
  filePath: string,
  serialized: string
): Promise<void> {
  await removeStaleDurableWriteTempFiles(filePath, { minimumAgeMs: STALE_WRITE_TEMP_FILE_AGE_MS })
  const tempPath = durableWriteTempPath(filePath)
  try {
    await writeTempFileDurable(tempPath, serialized, 0o600)
    await renameDurable(tempPath, filePath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

export async function publishRecoveryCapsuleState(
  filePath: string,
  records: Pick<RecoveryCapsuleState, 'entries' | 'failed'>,
  now: number,
  dismissedAt: number | undefined
): Promise<void> {
  const { entries, failed } = normalizeState(records, now)
  const { serialized } = stringifyJsonWithinByteLimit(
    {
      version: 2,
      entries: entries.map((entry) => ({
        ...entry,
        marker: storedAgentSessionResumeMarker(entry.marker),
        ...(entry.replacement
          ? { replacement: storedAgentSessionResumeMarker(entry.replacement) }
          : {})
      })),
      ...(dismissedAt === undefined ? {} : { dismissedAt }),
      ...(failed.length === 0
        ? {}
        : {
            failed: failed.map((failure) => ({
              ...failure,
              marker: storedAgentSessionResumeMarker(failure.marker)
            }))
          })
    },
    MAX_CAPSULE_BYTES
  )
  await writeRecoveryFileDurable(filePath, serialized)
  recoveryCapsulePublished(filePath)
}

// Who hears each publish of an offers file, in this process (reply recovery's holds).
const publishedListeners = new Map<string, Set<() => void>>()

/** Called after each publish of the offers file; returns the unsubscribe. */
export function onRecoveryCapsulePublished(filePath: string, listener: () => void): () => void {
  const listeners = publishedListeners.get(filePath) ?? new Set()
  listeners.add(listener)
  publishedListeners.set(filePath, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      publishedListeners.delete(filePath)
    }
  }
}

function recoveryCapsulePublished(filePath: string): void {
  for (const listener of publishedListeners.get(filePath) ?? []) {
    try {
      listener()
    } catch (error) {
      console.warn('[agent-session] a recovery capsule listener failed', error)
    }
  }
}

/** Every offer a continuation may still answer: pending, in an action now (and its replacement),
 *  or failed and open to a retry. Read under the file's lock, like the capsule's own reads. */
export function readStandingRecoveryOffers(
  filePath: string,
  now: number
): Promise<AgentSessionResumeMarker[]> {
  return withFileTransactionLock(filePath, async () => {
    const { entries, failed } = normalizeState(await readRecoveryCapsuleState(filePath), now)
    return [
      ...entries.flatMap((entry) =>
        entry.replacement ? [entry.marker, entry.replacement] : [entry.marker]
      ),
      ...failed.map((failure) => failure.marker)
    ]
  })
}
