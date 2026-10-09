import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

it('publishes idle permission changes to every subscriber without changing the journal or repeating unchanged state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-publication-'))
  const journals = createTrackedJournalOpener()
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: root
    })
    let mode: AgentChatPermissionMode = 'ask'
    const events: AgentSessionSubscribeEvent[][] = [[], []]
    const subscribers = new AgentSessionSubscribers({
      readPermissionFact: () => ({ mode, fence: 1 })
    })
    const cursor = journal.cursor()
    for (const [index, received] of events.entries()) {
      subscribers.open({
        id: String(index),
        sessionId: 'session-1',
        journal,
        fence: 1,
        emit: (event) => received.push(event)
      })
      expect(received[0]).toMatchObject({ type: 'snapshot', permissionMode: 'ask' })
    }
    mode = 'bypass'
    subscribers.publish('session-1', journal)
    for (const received of events) {
      expect(received).toHaveLength(2)
      expect(received[1]).toMatchObject({
        type: 'batch',
        permissionMode: 'bypass',
        batch: { cursor, items: [], submissions: [], removedItemIds: [] }
      })
      let state = EMPTY_STRUCTURED_AGENT_SESSION
      for (const event of received) {
        state = reduceStructuredAgentSession(state, { type: 'event', event })
      }
      expect(state.permissionMode).toBe('bypass')
      expect(state.cursor).toEqual(cursor)
    }
    subscribers.publish('session-1', journal)
    expect(events.map((received) => received.length)).toEqual([2, 2])
    const reconnected: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'reconnect',
      sessionId: 'session-1',
      journal,
      fence: 1,
      cursor,
      emit: (event) => reconnected.push(event)
    })
    expect(reconnected[0]).toMatchObject({ type: 'batch', permissionMode: 'bypass' })
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the last known permission when an older host omits the optional field', () => {
  const cursor = { epoch: 'e', sequence: 0 }
  const snapshot: AgentSessionSubscribeEvent = {
    type: 'snapshot',
    sessionId: 's',
    fence: 1,
    permissionMode: 'ask',
    page: {
      sessionId: 's',
      epoch: 'e',
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: cursor },
      hasOlder: false,
      hasNewer: false
    }
  }
  const state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: snapshot
  })
  const newer = reduceStructuredAgentSession(state, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      permissionMode: 'bypass',
      batch: { cursor, items: [], removedItemIds: [], submissions: [] }
    }
  })
  expect(newer.permissionMode).toBe('bypass')
  const oldFrame: AgentSessionSubscribeEvent = {
    type: 'batch',
    sessionId: 's',
    batch: { cursor, items: [], removedItemIds: [], submissions: [] }
  }
  expect(reduceStructuredAgentSession(newer, { type: 'event', event: oldFrame })).toBe(newer)
  expect(
    reduceStructuredAgentSession(newer, {
      type: 'event',
      event: { ...snapshot, permissionMode: undefined }
    }).permissionMode
  ).toBe('bypass')
})
