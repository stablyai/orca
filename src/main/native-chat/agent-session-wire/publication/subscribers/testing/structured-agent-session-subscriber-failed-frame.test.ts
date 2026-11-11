import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { createTrackedJournalOpener } from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'

const SESSION = 'failed-frame-session'
let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-subscriber-failed-frame-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

// #39926: a frame that failed to send dropped the subscriber but left its stream open, so the chat
// view sat on a healthy-looking, silent stream until the tab was reopened.
it('ends the stream of a subscriber dropped after a frame fails to send', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(root, 'journal')
  })
  const subscribers = new AgentSessionSubscribers()
  const received: AgentSessionSubscribeEvent['type'][] = []
  const end = vi.fn()
  subscribers.open({
    id: 'chat-pane',
    sessionId: SESSION,
    journal,
    fence: 1,
    end,
    emit: (event) => {
      if (event.type === 'batch') {
        throw new Error('frame could not be sent')
      }
      received.push(event.type)
    }
  })
  expect(received).toEqual(['snapshot'])

  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'reply' },
    { kind: 'status', text: 'reply' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  subscribers.publish(SESSION, journal)

  expect(subscribers.subscriberCountForTests(SESSION)).toBe(0)
  expect(end).toHaveBeenCalledTimes(1)
})
