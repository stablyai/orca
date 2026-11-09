import {
  hasTerminalHistoryRecoveryProtection,
  fingerprintTerminalHistorySession,
  type HistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import { TerminalHistoryMutationTracker } from './terminal-history-mutation-tracker'
import type { TerminalHistoryRecoveryFreezes } from './terminal-history-recovery-freezes'
import { updateTerminalHistoryMeta } from './terminal-history-metadata'
import type { HistoryParticipant } from './terminal-history-root-registry'
import type { TerminalHistoryRoot } from './terminal-history-root'
import {
  TerminalHistoryWriterAdmissions,
  type HistoryWriterPreparation
} from './terminal-history-writer-admission'
import { tombstoneCapturedSessionTree } from './terminal-history-session-tombstone'

export function settleCapturedTerminalHistoryWriter(
  id: string,
  writer: TerminalHistorySessionWriter,
  removeHistory: boolean,
  writers: Map<string, TerminalHistorySessionWriter>,
  disabled: Set<string>,
  basePath: string
): void {
  if (writers.get(id) !== writer) {
    return
  }
  if (removeHistory) {
    tombstoneCapturedSessionTree(basePath, writer.dir)
  }
  writers.delete(id)
  disabled.delete(id)
}

export function registerTerminalHistoryManager(
  root: TerminalHistoryRoot | null,
  participant: HistoryParticipant
) {
  const release = root?.registerManager(participant)
  const acquisitions = new TerminalHistoryMutationTracker()
  const admissions = new TerminalHistoryWriterAdmissions(root)
  return {
    release,
    acquire: <T>(
      id: string,
      preparation: HistoryWriterPreparation,
      operation: (deadlineMs: number) => T | Promise<T>
    ) => acquisitions.track(id, admissions.acquire(id, preparation, operation)),
    closeAdmissions: () => admissions.close(),
    admissionsOpen: admissions.isOpen,
    drainAcquisitions: () => acquisitions.waitAll(),
    drainRetired: (id: string) => root?.drainRetired(id, participant),
    retire: (producerTail: (id: string) => Promise<unknown>) => {
      admissions.close()
      participant.retiring = async (id) => {
        await producerTail(id)
        await acquisitions.wait(id)
        await participant.drain(id)
      }
    }
  }
}

export async function releaseTerminalHistoryManager(
  disposition: 'clean' | 'detach',
  writers: Map<string, TerminalHistorySessionWriter>,
  disabledSessions: Set<string>,
  lifecycleMutations: TerminalHistoryMutationTracker,
  mutations: TerminalHistoryMutationTracker,
  recoveryFreezes: TerminalHistoryRecoveryFreezes,
  unregister?: () => void
): Promise<void> {
  await lifecycleMutations.waitAll()
  await mutations.waitAll()
  if (disposition === 'clean') {
    // Orderly teardown ends only this adapter's writers; recoverable disconnect preserves them.
    for (const [sessionId, writer] of writers) {
      try {
        updateTerminalHistoryMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode: null })
      } catch {
        disabledSessions.add(sessionId)
      }
    }
  }
  writers.clear()
  recoveryFreezes.releaseAll()
  unregister?.()
}

export function closeTerminalHistoryWriter(
  id: string,
  exitCode: number,
  writers: Map<string, TerminalHistorySessionWriter>,
  disabled: Set<string>,
  onError: (error: unknown) => void
): void {
  const writer = writers.get(id)
  if (!writer) {
    return
  }
  writers.delete(id)
  disabled.delete(id)
  try {
    updateTerminalHistoryMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode })
  } catch (error) {
    onError(error)
  }
}

export function reopenTerminalHistoryWriter(
  id: string,
  writers: Map<string, TerminalHistorySessionWriter>,
  onError: (error: unknown) => void
): void {
  const writer = writers.get(id)
  if (writer) {
    try {
      updateTerminalHistoryMeta(writer.dir, { endedAt: null, exitCode: null })
    } catch (error) {
      onError(error)
    }
  }
}

export function registerRecoveredTerminalHistoryWriter(
  basePath: string,
  id: string,
  recoveryFreeze: HistoryRecoveryFreeze | undefined,
  writers: Map<string, TerminalHistorySessionWriter>,
  freezes: TerminalHistoryRecoveryFreezes,
  maxBytes: number,
  onProtected: () => void,
  onError: (error: unknown) => void
): void {
  if (writers.has(id)) {
    return
  }
  if (hasTerminalHistoryRecoveryProtection(basePath, id)) {
    freezes.abandon(recoveryFreeze)
    return onProtected()
  }
  if (recoveryFreeze) {
    try {
      const activeFreeze = freezes.require(id, recoveryFreeze)
      if (fingerprintTerminalHistorySession(basePath, id) !== activeFreeze.fingerprint) {
        throw new Error('terminal_history_recovery_generation_changed')
      }
      freezes.release(id)
    } catch (error) {
      freezes.abandon(recoveryFreeze)
      onError(error)
      return
    }
  } else if (freezes.has(id)) {
    return
  }
  writers.set(
    id,
    new TerminalHistorySessionWriter(join(basePath, getHistorySessionDirName(id)), false, maxBytes)
  )
}
