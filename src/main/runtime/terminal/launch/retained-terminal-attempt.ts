import { requireAcceptedSpawn, type PtySpawnOutcome } from '../../../ipc/pty/spawn-outcome'
import {
  RetainedTerminalStartError,
  type RetainedTerminalStart
} from '../../../../shared/workspace-layout/retained-terminal-start'
import {
  paneStartFailure,
  type PaneStartFact,
  type PaneStartStatuses,
  type RetainedStartBinding
} from '../surface/pane-start-statuses'
import type { PaneSpawnReservation } from '../../../ipc/pty/pane/spawn-reservation'

export function createRetainedTerminalAttempt({
  previous,
  predecessor,
  paneKey,
  sink,
  owner,
  currentStart,
  bindingOf,
  generationOf,
  isCurrent,
  publish
}: {
  previous: RetainedTerminalStart
  predecessor: PaneStartFact
  paneKey: string
  sink: PaneStartStatuses
  owner: { key: string; reservation: PaneSpawnReservation }
  currentStart: () => RetainedTerminalStart | null
  bindingOf: (start: RetainedTerminalStart) => RetainedStartBinding
  generationOf: (start: RetainedTerminalStart) => number
  isCurrent: (fact: PaneStartFact) => boolean
  publish: (start: RetainedTerminalStart) => void
}) {
  const start: RetainedTerminalStart = {
    ...previous,
    status: 'starting',
    reason: '',
    startSequence: sink.nextStartSequence()
  }
  sink.set(paneKey, {
    status: 'starting',
    retainedTerminalStart: start,
    retainedStartBinding: predecessor.retainedStartBinding,
    inFlightOperation: owner.reservation
  })
  publish(start)
  const retire = (): void => {
    const fact = sink.peek(paneKey)
    if (fact?.retainedTerminalStart === start) {
      sink.clear(paneKey, fact)
    }
  }
  const failed = (error: unknown, ended?: PtySpawnOutcome): unknown => {
    const binding = bindingOf(start)
    const current = sink.peek(paneKey)
    if (ended) {
      if (
        (current && current.retainedTerminalStart !== start) ||
        binding.ptyId !== ended.result.id ||
        binding.incarnationId !== ended.result.incarnationId
      ) {
        return error
      }
    } else if (currentStart() !== start) {
      return error
    }
    const failure = paneStartFailure(error)
    const retained: RetainedTerminalStart = {
      ...start,
      ...(ended
        ? {
            bindingGeneration: generationOf(start)
          }
        : {}),
      status: failure.status === 'held' ? 'held' : 'failed',
      reason: failure.reason ?? ''
    }
    const fact = {
      ...failure,
      retainedTerminalStart: retained,
      ...(ended ? { retainedStartBinding: binding } : {})
    }
    if (ended && !isCurrent(fact)) {
      return error
    }
    sink.set(paneKey, fact)
    publish(retained)
    return new RetainedTerminalStartError(error, retained)
  }
  return {
    failed,
    abandoned: () => {
      if (currentStart() === start) {
        const restored = { ...start, status: previous.status, reason: previous.reason }
        sink.set(paneKey, { ...predecessor, retainedTerminalStart: restored })
        publish(restored)
      }
    },
    finalized: () => {
      const current = sink.peek(paneKey)
      if (
        current?.retainedTerminalStart === start &&
        current.inFlightOperation === owner.reservation
      ) {
        delete current.inFlightOperation
      }
    },
    accepted: retire,
    completed: (outcome: PtySpawnOutcome): unknown => {
      if (outcome.kind !== 'registration-exited') {
        retire()
        return undefined
      }
      try {
        requireAcceptedSpawn(outcome)
      } catch (error) {
        return failed(error, outcome)
      }
      return undefined
    }
  }
}

export type RetainedTerminalAttempt = ReturnType<typeof createRetainedTerminalAttempt>
