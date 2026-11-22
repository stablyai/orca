import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { LiveTextReaders } from '../../../journal-ingress/structured-agent-session-event-sink'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

// Perf contract: each streaming window reuses the session's reader groups, so hidden subscribers
// cost no copying, filtering or reader building per window; only a join, leave, show or hide does.
it('builds reader groups once per membership change, not once per window', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, SESSION)
  })
  const subscribers = new AgentSessionSubscribers({ readSessionJournal: () => journal })
  const open = async (id: string, shown?: boolean) => {
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id,
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => events.push(event),
      ...(shown === undefined ? {} : { liveTextViewer: `viewer:${id}`, liveTextShown: shown })
    })
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  }
  await open('shown', true)
  for (let hidden = 0; hidden < 50; hidden++) {
    await open(`hidden-${hidden}`, hidden % 2 === 0 ? false : undefined)
  }
  const seen = new Set<LiveTextReaders>()
  const read = (readers?: LiveTextReaders): readonly AgentJournalRenderItem[] => {
    if (readers) {
      seen.add(readers)
    }
    return []
  }
  for (let window = 0; window < 100; window++) {
    subscribers.publishLiveText(SESSION, journal, 1, read)
  }
  // One readers object for the shown group and one for the rest, across all 100 windows.
  expect(seen.size).toBe(2)

  await open('late', false)
  subscribers.publishLiveText(SESSION, journal, 1, read)
  expect(seen.size).toBe(4)
})
