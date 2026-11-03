// Claim checks and deletion marks arbitrate with sends in the same journal database.
// Retain claimed uploads while any recorded chat holds them; resume interrupted deletions on later sweeps.

import { readdir, stat } from 'node:fs/promises'
import { sweepAttachmentClaims } from './agent-session-attachment-claim-sweep'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type {
  JournalPersistenceEffect,
  JournalEffectResult
} from '../agent-session-journal/journal-persistence-plan'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import { removeQuietly, type AgentSessionAttachmentStore } from './agent-session-attachment-store'

export const ABANDONED_PART_MAX_AGE_MS = 60 * 60 * 1000
export const UNCLAIMED_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type AgentSessionAttachmentSweepFacts = {
  /** Without a writable journal, only unfinished part files may be removed. */
  database: () => Pick<JournalHostDatabase, 'transaction' | 'read'> | null
  /** null means imports are incomplete; no chat claims can yet be judged orphaned. */
  recordedSessionIds: () => Pick<ReadonlySet<string>, 'has'> | null
  onUploadRemoved?: (uploadDir: string) => void
}

export type AgentSessionAttachmentSweepResult = { removed: string[] }

export async function sweepAgentSessionAttachments(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  now = Date.now()
): Promise<AgentSessionAttachmentSweepResult> {
  const removed: string[] = []
  // Disk awaits can outlive journal closure; resolve the database again for each statement.
  const { database } = facts
  const write = async (
    operation: Extract<JournalPersistenceEffect, { kind: 'sweep' }>['operation']
  ): Promise<JournalEffectResult | undefined> => {
    const db = database()
    if (!db) {
      return undefined
    }
    let value: JournalEffectResult | undefined
    await db.transaction((plan) => {
      plan.add({ kind: 'sweep', operation }, (result) => {
        value = result
      })
    })
    return value
  }
  const marked = await database()?.read(async (read) =>
    (await read.prepare('SELECT upload_id FROM agent_session_attachment_sweeps').all()).flatMap(
      (row) => (typeof row.upload_id === 'string' ? [row.upload_id] : [])
    )
  )
  const remove = async (uploadDir: string): Promise<void> => {
    await removeQuietly(uploadDir)
    facts.onUploadRemoved?.(uploadDir)
  }
  for (const uploadId of marked ?? []) {
    await remove(join(store.rootDir, uploadId))
    await write({ kind: 'finish', uploadId })
  }
  for (const uploadId of await listDirectories(store.rootDir)) {
    if (store.isUploadInFlight(uploadId)) {
      continue
    }
    const uploadDir = join(store.rootDir, uploadId)
    const stored = (await readdir(uploadDir)).some(
      (entry) => entry !== AGENT_SESSION_ATTACHMENT_PART_FILE
    )
    const ageMs = now - (await modifiedAt(uploadDir))
    if (!stored) {
      if (ageMs > ABANDONED_PART_MAX_AGE_MS) {
        await remove(uploadDir)
        removed.push(uploadDir)
      }
      continue
    }
    // Whichever lands first wins: claims retain uploads, sweep marks reject later claims.
    if (
      ageMs <= UNCLAIMED_ATTACHMENT_MAX_AGE_MS ||
      (await write({ kind: 'mark', uploadId, now })) !== true
    ) {
      continue
    }
    await remove(uploadDir)
    await write({ kind: 'finish', uploadId })
    removed.push(uploadDir)
  }
  await sweepAttachmentClaims(store, facts)
  return { removed }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export type AgentSessionAttachmentSweeper = { stop: () => void }

/** Retry failed background sweeps without blocking host work. */
export function startAgentSessionAttachmentSweeps(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  options: {
    initialDelayMs: number
    intervalMs: number
    onError: (error: unknown) => void
  }
): AgentSessionAttachmentSweeper {
  let running = false
  let stopped = false
  const run = (): void => {
    if (running || stopped) {
      return
    }
    running = true
    void sweepAgentSessionAttachments(store, facts)
      .catch(options.onError)
      .finally(() => {
        running = false
      })
  }
  const initial = setTimeout(run, options.initialDelayMs)
  const interval = setInterval(run, options.intervalMs)
  initial.unref?.()
  interval.unref?.()
  return {
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    }
  }
}
