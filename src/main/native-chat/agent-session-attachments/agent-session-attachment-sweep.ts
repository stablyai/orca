// When a stored attachment may go, re-derived on every sweep from the disk and the claim table.
//
// - A part file nobody is writing (the uploader crashed or vanished) goes after an hour.
// - An upload no message ever claimed goes after a day: its chip was removed or its draft
//   abandoned. The sweep first marks it in the same database the claims live in, and only if no
//   claim exists; a send that names it afterwards is refused instead of losing its file.
// - A claimed upload stays while any chat holding it has a record. The host never deletes a chat
//   today, so that is as long as its transcript.
// - A mark left by a sweep that died mid-delete is finished by the next one.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import {
  finishUploadSweep,
  listUploadsBeingSwept,
  markUnclaimedUploadForSweep,
  pruneAgentSessionAttachmentClaims
} from './agent-session-attachment-claims'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import { removeQuietly, type AgentSessionAttachmentStore } from './agent-session-attachment-store'

export const ABANDONED_PART_MAX_AGE_MS = 60 * 60 * 1000
export const UNCLAIMED_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type AgentSessionAttachmentSweepFacts = {
  /** The host's journal connection, or null when it cannot take writes (closed, or written by a
   *  newer Orca): without it nothing claimed can be told apart, so only part files go. */
  database: () => Database.Database | null
  /** Every chat this host holds a record for; null while that list is incomplete (records still
   *  owed their import), when no chat's claims can be judged orphaned. */
  recordedSessionIds: () => Pick<ReadonlySet<string>, 'has'> | null
}

export type AgentSessionAttachmentSweepResult = { removed: string[] }

export async function sweepAgentSessionAttachments(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  now = Date.now()
): Promise<AgentSessionAttachmentSweepResult> {
  const removed: string[] = []
  // Read again at every statement: the host may close the connection while the sweep awaits disk.
  const { database } = facts
  for (const uploadId of withDatabase(database, listUploadsBeingSwept) ?? []) {
    await removeQuietly(join(store.rootDir, uploadId))
    withDatabase(database, (db) => finishUploadSweep(db, uploadId))
  }
  for (const uploadId of await listDirectories(store.rootDir)) {
    if (store.isUploadInFlight(uploadId)) {
      continue
    }
    const uploadDir = join(store.rootDir, uploadId)
    const stored = (await listEntries(uploadDir)).some(
      (entry) => entry !== AGENT_SESSION_ATTACHMENT_PART_FILE
    )
    const ageMs = now - (await modifiedAt(uploadDir))
    if (!stored) {
      if (ageMs > ABANDONED_PART_MAX_AGE_MS) {
        await removeQuietly(uploadDir)
        removed.push(uploadDir)
      }
      continue
    }
    // A claim landing first keeps the upload; this mark landing first refuses that claim.
    if (
      ageMs <= UNCLAIMED_ATTACHMENT_MAX_AGE_MS ||
      withDatabase(database, (db) => markUnclaimedUploadForSweep(db, uploadId, now)) !== true
    ) {
      continue
    }
    await removeQuietly(uploadDir)
    withDatabase(database, (db) => finishUploadSweep(db, uploadId))
    removed.push(uploadDir)
  }
  withDatabase(database, (db) =>
    pruneAgentSessionAttachmentClaims(db, {
      root: store.rootDir,
      recordedSessionIds: facts.recordedSessionIds()
    })
  )
  return { removed }
}

function withDatabase<T>(
  database: AgentSessionAttachmentSweepFacts['database'],
  run: (db: Database.Database) => T
): T | undefined {
  const db = database()
  return db ? run(db) : undefined
}

async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
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

/**
 * Sweeps shortly after the host comes up and then periodically. Best effort: a failed sweep is
 * logged and the next one tries again; nothing waits on it.
 */
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
