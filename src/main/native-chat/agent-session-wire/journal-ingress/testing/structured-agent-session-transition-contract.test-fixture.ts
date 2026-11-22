import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalToolCallItem
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { JournalLifecycleIdentityMutationInput } from '../../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { createDeferredStructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../host/testing/structured-agent-session-logger.test-fixture'
import type { StructuredAgentSessionTransitionStep } from '../structured-agent-session-transition'
import type { JournalTimelineItemResolution } from '../../../agent-session-journal/writing/journal-timeline-resolution'

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

export function failedTool(id: AgentJournalItemIdentity): JournalLifecycleIdentityMutationInput {
  return {
    kind: 'item',
    identity: id,
    body: tool('read', 'failed'),
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

export function itemStep(
  resolution: JournalTimelineItemResolution,
  reservedBytes = 4096
): StructuredAgentSessionTransitionStep {
  return {
    kind: 'item',
    reservedBytes,
    resolution,
    options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  }
}

export async function rig(
  options: Pick<
    Parameters<typeof createDeferredStructuredAgentSessionEventSink>[0],
    'watermarks' | 'readingControl'
  > = {}
) {
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
    ...options
  })
  const bind = () => deferred.bind({ journal, fence: 1, publish: () => publishes.push(1) })
  return { root, journal, deferred, sink: deferred.sink, publishes, bind }
}
