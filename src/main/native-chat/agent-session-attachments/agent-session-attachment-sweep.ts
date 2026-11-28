// Claim checks and deletion marks arbitrate with sends in the same journal database.
// Retain claimed uploads while any recorded chat holds them; resume interrupted deletions on later sweeps.
// Nothing is removed or pruned while an older Orca's journal may hold an upload this one can't see.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import { removeQuietly, type AgentSessionAttachmentStore } from './agent-session-attachment-store'

export const ABANDONED_PART_MAX_AGE_MS = 60 * 60 * 1000
export const UNCLAIMED_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type AgentSessionAttachmentSweepFacts = {
  /** True only when no older Orca's journal may hold an upload unclaimed here; else remove nothing. */
  legacyCustodyKnown: () => boolean | Promise<boolean>
  isUnclaimed: (uploadId: string) => boolean | Promise<boolean>
  listBeingSwept: () => readonly string[] | Promise<readonly string[]>
  markForSweep: (uploadId: string, now: number) => boolean | Promise<boolean>
  finishSweep: (uploadId: string) => void | Promise<void>
  pruneClaims: () => void | Promise<void>
  /** Uploads waiting for a durable item mail recipient to claim them. */
  retention?: {
    /** Null means a store that can retain uploads could not be read; keep every upload. */
    uploads: () => Promise<ReadonlySet<string> | null>
  }
  onUploadRemoved?: (uploadDir: string) => void
  onLegacyCustodyUnknown?: () => void
}

export type AgentSessionAttachmentSweepResult = { removed: string[] }

export async function sweepAgentSessionAttachments(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  now = Date.now(),
  stopped: () => boolean = () => false
): Promise<AgentSessionAttachmentSweepResult> {
  const removed: string[] = []
  // Before any mark, folder or claim prune: a pruned claim of an unadopted chat loses its upload.
  if (!(await facts.legacyCustodyKnown())) {
    facts.onLegacyCustodyUnknown?.()
    return { removed }
  }
  // Undefined until read; null keeps every stored upload this pass.
  let retained: ReadonlySet<string> | null | undefined
  const retainedUploads = async (): Promise<ReadonlySet<string> | null> =>
    (retained ??= facts.retention
      ? await facts.retention.uploads().catch(() => null)
      : new Set<string>())
  const remove = async (uploadDir: string): Promise<void> => {
    await removeQuietly(uploadDir)
    facts.onUploadRemoved?.(uploadDir)
  }
  for (const uploadId of await facts.listBeingSwept()) {
    // A claim that landed after the mark, such as one an older Orca's journal carried in, wins.
    if (!(await facts.isUnclaimed(uploadId))) {
      await facts.finishSweep(uploadId)
      continue
    }
    const kept = await retainedUploads()
    if (kept === null) {
      continue
    }
    if (kept.has(uploadId)) {
      await facts.finishSweep(uploadId)
      continue
    }
    if (stopped()) {
      return { removed }
    }
    await remove(join(store.rootDir, uploadId))
    await facts.finishSweep(uploadId)
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
      // Recheck after the awaits: a content write may have reused this folder meanwhile.
      if (ageMs > ABANDONED_PART_MAX_AGE_MS && !store.isUploadInFlight(uploadId)) {
        if (stopped()) {
          return { removed }
        }
        await remove(uploadDir)
        removed.push(uploadDir)
      }
      continue
    }
    // Whichever lands first wins: claims retain uploads, sweep marks reject later claims.
    if (ageMs <= UNCLAIMED_ATTACHMENT_MAX_AGE_MS) {
      continue
    }
    // Item mail retention is read only once an old upload is otherwise unclaimed.
    if (retained === undefined && facts.retention && !(await facts.isUnclaimed(uploadId))) {
      continue
    }
    const kept = await retainedUploads()
    if (
      kept === null ||
      kept.has(uploadId) ||
      stopped() ||
      !(await facts.markForSweep(uploadId, now))
    ) {
      continue
    }
    if (stopped()) {
      return { removed }
    }
    await remove(uploadDir)
    await facts.finishSweep(uploadId)
    removed.push(uploadDir)
  }
  if (!stopped()) {
    await facts.pruneClaims()
  }
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

/** Retry failed background sweeps without blocking host work; stop ends a running pass's removals. */
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
    void sweepAgentSessionAttachments(store, facts, Date.now(), () => stopped)
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
