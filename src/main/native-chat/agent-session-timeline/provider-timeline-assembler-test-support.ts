import type {
  ProviderTimelineRig,
  UnboundProviderTimelineAssembler
} from './provider-timeline-assembler-test-data'
export type {
  ProviderTimelineRig,
  UnboundProviderTimelineAssembler
} from './provider-timeline-assembler-test-data'
import {
  SESSION,
  AGENT,
  GENERATION,
  NAMESPACE,
  providerTurnId
} from './provider-timeline-assembler-test-data'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import { createProviderTimelineAssembler } from './provider-timeline-assembler'
import type {
  ProviderTimelineAssembler,
  ProviderTimelineAssemblerDeps
} from './provider-timeline-assembler'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import { providerTimelineSink } from './provider-timeline-plan'
import type { TestJournalOptions } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { ProviderTimelineSink } from './provider-timeline-plan'

export {
  SESSION,
  AGENT,
  GENERATION,
  NAMESPACE,
  providerItemId,
  providerTurnItemId,
  providerTurnId,
  runningTool,
  backgroundTask,
  backgroundTaskState,
  assistantText,
  pendingApproval,
  messageText
} from './provider-timeline-assembler-test-data'
// Exercise grammar events through the real deferred sink and on-disk journal.

let journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
const roots: string[] = []
let scopedOwnership = false
const ownedSinks: { root: string; stop: () => void; drain: () => Promise<void> }[] = []
export function registerScopedProviderTimelineOwnership(): void {
  scopedOwnership = true
  journals = createTrackedJournalOpener({ scoped: true })
}

export async function closeProviderTimelineRigs(): Promise<void> {
  if (scopedOwnership) {
    const owned = ownedSinks.splice(0)
    const directories = roots.splice(0)
    const failures: unknown[] = []
    const blocked = new Set<string>()
    for (const sink of owned) {
      try {
        sink.stop()
      } catch (error) {
        blocked.add(sink.root)
        failures.push(error)
      }
    }
    for (const sink of owned) {
      try {
        await sink.drain()
      } catch (error) {
        blocked.add(sink.root)
        failures.push(new Error(`timeline sink retained: ${sink.root}`, { cause: { sink, error } }))
      }
    }
    try {
      await journals.dispose(directories, [...blocked])
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'timeline cleanup failed')
    }
    return
  }
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
}

/** Admit before journal binding to simulate resume events without a journal view. */

export function openUnboundProviderTimelineAssembler(
  journal: AgentSessionJournal,
  overrides: Partial<ProviderTimelineAssemblerDeps> = {}
): UnboundProviderTimelineAssembler {
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  let ownedAssembler: ProviderTimelineAssembler | undefined
  let bound = false
  if (scopedOwnership) {
    ownedSinks.push({
      root: journal['database'].stateDirectory,
      stop: () => ownedAssembler?.dispose(),
      drain: async () => {
        const discarded = !bound && deferred.state().queuedOperations > 0
        if (!bound) {
          deferred.close()
        }
        const result = await deferred.drained()
        deferred.close()
        if (!result.ok) {
          throw result.error
        }
        if (discarded) {
          throw new Error('unbound timeline sink retained admitted writes at cleanup')
        }
      }
    })
  }
  const sink = providerTimelineSink(deferred.sink)
  if (!sink) {
    throw new Error('the deferred sink offers transitions')
  }
  const assembler = createProviderTimelineAssembler({
    sink,
    sessionId: SESSION,
    agent: AGENT,
    generation: 'gen-unbound',
    namespace: NAMESPACE,
    // Tests explicitly flush this window.
    schedule: () => () => {},
    ...overrides
  })
  ownedAssembler = assembler
  if (!scopedOwnership) {
    cleanups.push(async () => {
      assembler.dispose()
      deferred.close()
    })
  }
  return {
    assembler,
    bind: async () => {
      deferred.bind({ journal, fence: 1, publish: () => {} })
      bound = true
      await deferred.drained()
    },
    drained: async () => {
      await deferred.drained()
    }
  }
}

export function refusingSink(
  sink: ProviderTimelineSink,
  refusing: () => boolean,
  reason: 'backpressure' | 'failed' = 'backpressure'
): ProviderTimelineSink {
  return {
    ...sink,
    tryAppendTransition: (transition) =>
      refusing() ? { accepted: false, reason } : sink.tryAppendTransition(transition)
  }
}

/** Override journalIdentity when the lane writes another agent’s journal directly. */
export async function openProviderTimelineRig(
  overrides: Partial<ProviderTimelineAssemblerDeps> = {},
  journalIdentity: Partial<Pick<TestJournalOptions['identity'], 'agent' | 'providerHandle'>> = {}
): Promise<ProviderTimelineRig> {
  const root = await mkdtemp(join(tmpdir(), 'orca-provider-timeline-'))
  roots.push(root)
  if (scopedOwnership) {
    journals.ownRoot(root)
  }
  const journalOptions: TestJournalOptions = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: AGENT,
      providerHandle: { transport: 'acp', agent: AGENT, nativeId: 'provider-session-1' },
      ...journalIdentity
    },
    stateDirectory: root,
    now: () => 1_000
  }
  const journal = await journals.open(journalOptions)
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const assemblers = new Set<ProviderTimelineAssembler>()
  if (scopedOwnership) {
    ownedSinks.push({
      root,
      stop: () => {
        for (const assembler of assemblers) {
          assembler.dispose()
        }
      },
      drain: async () => {
        const result = await deferred.drained()
        deferred.close()
        if (!result.ok) {
          throw result.error
        }
      }
    })
  }
  deferred.bind({ journal, fence: 1, publish: () => {} })
  if (!scopedOwnership) {
    cleanups.push(async () => {
      deferred.close()
    })
  }
  const sink = providerTimelineSink(deferred.sink)
  if (!sink) {
    throw new Error('the deferred sink offers transitions')
  }
  // Flush windows before reads unless the test supplies its own scheduling.
  const windows = new Set<() => void>()
  const elapse = () => {
    // Retries scheduled by refused flushes wait for the next read.
    const due = Array.from(windows)
    windows.clear()
    due.forEach((run) => run())
  }
  const build = (more: Partial<ProviderTimelineAssemblerDeps> = {}) => {
    const assembler = createProviderTimelineAssembler({
      sink,
      sessionId: SESSION,
      agent: AGENT,
      generation: GENERATION,
      namespace: NAMESPACE,
      schedule: (run) => {
        windows.add(run)
        return () => windows.delete(run)
      },
      ...overrides,
      ...more
    })
    if (scopedOwnership) {
      assemblers.add(assembler)
    }
    return assembler
  }
  const rows = async () => {
    elapse()
    await deferred.drained()
    return journal.snapshot().items
  }
  const turns = async () =>
    (await rows()).flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
  let generations = 1
  const rig: ProviderTimelineRig = {
    journal,
    assembler: build(),
    sink,
    eventSink: deferred.sink,
    reopenJournal: async () => {
      await rows()
      await journal.close()
      await closeTestJournalHostDatabase(root)
      return journals.open(journalOptions)
    },
    restart: async (more = {}) => {
      generations += 1
      const generation = more.generation ?? `gen-${generations}`
      // Dispose drops the dead child’s buffered text, matching production.
      await deferred.drained()
      rig.assembler.dispose()
      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: SESSION,
        fence: 1,
        acquisitionGeneration: generation,
        deathEvidence: null
      })
      rig.assembler = build({ ...more, generation })
      return rig.assembler
    },
    assemble: build,
    rows,
    row: async (itemId) => (await rows()).find((item) => item.itemId === itemId),
    turns,
    turn: async (turnKey, namespace) => {
      const all = await turns()
      return (
        all.find((turn) => turn.turnId === providerTurnId(turnKey, namespace)) ??
        all.find((turn) => turn.turnId === turnKey)
      )
    }
  }
  return rig
}
