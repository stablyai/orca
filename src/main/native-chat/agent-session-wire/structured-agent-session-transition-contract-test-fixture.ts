import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalToolCallItem
} from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkWatermarks
} from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import type { StructuredAgentSessionTransitionStep } from './structured-agent-session-transition'

export const SESSION = 'session-transition'

export const journals = createTrackedJournalOpener({ legacyInputs: true })

export const roots: string[] = []

afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export function identity(recordId: string): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId }
}

export function tool(
  name: string,
  state: AgentJournalToolCallItem['state']
): AgentJournalToolCallItem {
  return { kind: 'tool-call', name, input: { name }, state }
}

export function failedTool(id: AgentJournalItemIdentity): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: id,
    body: tool('read', 'failed'),
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

export function itemStep(
  resolve: Extract<StructuredAgentSessionTransitionStep, { kind: 'item' }>['resolve'],
  reservedBytes = 4096
): StructuredAgentSessionTransitionStep {
  return {
    kind: 'item',
    reservedBytes,
    resolve,
    options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  }
}

export async function rig(watermarks: Partial<StructuredAgentSessionSinkWatermarks> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-transition-'))
  roots.push(root)
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'grok',
      providerHandle: { transport: 'acp', agent: 'grok', nativeId: 'provider-session-1' }
    },
    stateDirectory: root,
    now: () => 1_000
  })
  const publishes: number[] = []
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(SESSION),
    watermarks
  })
  const bind = () => deferred.bind({ journal, fence: 1, publish: () => publishes.push(1) })
  return { root, journal, deferred, sink: deferred.sink, publishes, bind }
}
