// Main deleted the shared provider-timeline rig (#46786), so this keeps the slice the Pi
// extension-UI tests need: a real lane sink and the journal rows it writes.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestJournalItems } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import {
  createTrackedJournalOpener,
  type TestJournalOptions
} from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { StructuredAgentSessionSettledTurnRoutes } from '../../native-chat/agent-session-wire/host/structured-agent-session-settled-turn-routes'
import { testEventSinkLogging } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createProviderTimelineAssembler } from '../../native-chat/agent-session-timeline/provider-timeline-assembler'
import {
  providerTimelineSink,
  type ProviderTimelineSink
} from '../../native-chat/agent-session-timeline/provider-timeline-plan'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

export const SESSION = 'session-extension-ui'
export const GENERATION = 'gen-1'
export const NAMESPACE = 'provider-session-1'

const notifiedRoutes = new WeakMap<AgentSessionJournal, StructuredAgentSessionSettledTurnRoutes>()

function eventTarget(journal: AgentSessionJournal): StructuredAgentSessionEventTarget {
  let routes = notifiedRoutes.get(journal)
  if (!routes) {
    routes = new StructuredAgentSessionSettledTurnRoutes({ warn: () => {}, error: () => {} })
    notifiedRoutes.set(journal, routes)
    const captured = routes
    journal.observeCommits((commit) =>
      captured.deliver(journal.identity.sessionId, journal, commit)
    )
  }
  const route = routes
  return {
    journal,
    fence: 1,
    publish: () => {},
    observeSettledTurns: (listener) => route.observe(journal.identity.sessionId, journal, listener)
  }
}

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
const roots: string[] = []

export async function closeExtensionUiRigs(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
}

/** The lane's sink and the journal rows it lands, for one Pi child generation. */
export type ExtensionUiRig = {
  sink: ProviderTimelineSink
  rows(): Promise<AgentJournalRenderItem[]>
}

export async function openExtensionUiRig(): Promise<ExtensionUiRig> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pi-extension-ui-'))
  roots.push(root)
  const options: TestJournalOptions = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: { transport: 'acp', agent: 'pi', nativeId: NAMESPACE }
    },
    stateDirectory: root,
    now: () => 1_000
  }
  const journal = await journals.open(options)
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind(eventTarget(journal))
  const sink = providerTimelineSink(deferred.sink)
  if (!sink) {
    throw new Error('the deferred sink offers transitions')
  }
  // Coalescing windows flush on read, so a row is always there when the test asks.
  const windows = new Set<() => void>()
  const assembler = createProviderTimelineAssembler({
    sink,
    sessionId: SESSION,
    agent: 'pi',
    generation: GENERATION,
    namespace: NAMESPACE,
    schedule: (run) => {
      windows.add(run)
      return () => windows.delete(run)
    }
  })
  cleanups.push(async () => {
    assembler.dispose()
    deferred.close()
  })
  return {
    sink,
    rows: async () => {
      const due = Array.from(windows)
      windows.clear()
      due.forEach((run) => run())
      await deferred.drained()
      return readTestJournalItems(journal)
    }
  }
}
