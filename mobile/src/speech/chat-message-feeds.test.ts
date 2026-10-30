import { beforeEach, describe, expect, it, vi } from 'vitest'

const tabsReply: { current: { tabs: unknown[] } } = { current: { tabs: [] } }
const tabsRequest = vi.fn(async () => ({ ok: true }))

vi.mock('../session/mobile-session-read-operations', () => ({
  sessionTabsListRead: {
    request: tabsRequest,
    interpret: () => tabsReply.current
  }
}))

const { assistantText, createChatMessageFeeds } = await import('./chat-message-feeds')
const { chatTargetForPane } = await import('./chat-feed-target')

const claudeTab = {
  type: 'terminal',
  id: 'tab-1',
  leafId: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  agentStatus: {
    agentType: 'claude',
    providerSession: { id: 'session-1', transcriptPath: '/t/session-1.jsonl' }
  }
}

function assistant(id: string, text: string, timestamp = 1000) {
  return { id, role: 'assistant', timestamp, blocks: [{ type: 'text', text }] }
}

function fakeClient() {
  const streams: { params: unknown; onFrame: (frame: unknown) => void; closed: boolean }[] = []
  const client = {
    subscribe: (_method: string, params: unknown, onFrame: (frame: unknown) => void) => {
      const stream = { params, onFrame, closed: false }
      streams.push(stream)
      return () => {
        stream.closed = true
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: feeds call only `subscribe`; tab reads go through the mocked `sessionTabsListRead`.
  return { client: client as never, streams }
}

const pane = {
  paneKey: 'host:tab-1:0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  rawPaneKey: 'tab-1:0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  worktreeId: 'wt'
}

describe('chatTargetForPane', () => {
  it('finds the transcript of the pane the row names', () => {
    expect(chatTargetForPane([claudeTab], 'tab-1:0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d')).toEqual({
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/t/session-1.jsonl'
    })
    expect(chatTargetForPane([claudeTab], 'tab-2:0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d')).toBeNull()
  })

  it('waits until the agent has reported a session', () => {
    const tab = { ...claudeTab, agentStatus: { agentType: 'claude', providerSession: null } }
    expect(chatTargetForPane([tab], 'tab-1:0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d')).toBeNull()
  })
})

describe('assistantText', () => {
  it('keeps assistant prose only', () => {
    expect(assistantText(assistant('a', 'Hello'))).toBe('Hello')
    expect(
      assistantText({ id: 'r', role: 'reasoning', blocks: [{ type: 'text', text: 'x' }] })
    ).toBe(null)
    expect(assistantText({ id: 't', role: 'assistant', blocks: [{ type: 'tool-call' }] })).toBe(
      null
    )
  })
})

describe('createChatMessageFeeds', () => {
  let spoken: string[]
  let speaking: boolean

  beforeEach(() => {
    tabsReply.current = { tabs: [claudeTab] }
    tabsRequest.mockClear()
    spoken = []
    speaking = true
  })

  const feedsUnderTest = () =>
    createChatMessageFeeds((_paneKey, _id, text) => {
      if (speaking) {
        spoken.push(text)
      }
      return speaking
    })

  it('reads messages appended after the history it opened on', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    expect(streams).toHaveLength(1)
    streams[0].onFrame({ type: 'snapshot', messages: [assistant('old', 'Old answer')] })
    expect(feeds.covers(pane.paneKey)).toBe(true)
    streams[0].onFrame({ type: 'appended', messages: [assistant('m1', 'Working on it')] })
    streams[0].onFrame({ type: 'appended', messages: [assistant('m1', 'Working on it')] })
    expect(spoken).toEqual(['Working on it'])
    expect(feeds.heard(pane.paneKey, 'Working on it')).toBe(true)
  })

  it('reads what the running turn already wrote when it opens mid-turn', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: 5000 }], 100_000)
    streams[0].onFrame({
      type: 'snapshot',
      messages: [assistant('old', 'Before', 4000), assistant('new', 'During', 6000)]
    })
    expect(spoken).toEqual(['During'])
  })

  it('does not remember messages it was told not to read', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    streams[0].onFrame({ type: 'snapshot', messages: [] })
    speaking = false
    streams[0].onFrame({ type: 'appended', messages: [assistant('m1', 'Final answer')] })
    expect(feeds.heard(pane.paneKey, 'Final answer')).toBe(false)
  })

  it('closes the feed of a pane that is gone and follows a new session', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    tabsReply.current = {
      tabs: [
        {
          ...claudeTab,
          agentStatus: { agentType: 'claude', providerSession: { id: 'session-2' } }
        }
      ]
    }
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 200_000)
    expect(streams.map((stream) => stream.closed)).toEqual([true, false])
    await feeds.sync('host', client, [], 300_000)
    expect(streams[1].closed).toBe(true)
  })

  it('reopens a feed on the client that replaced the one it was opened on', async () => {
    const feeds = feedsUnderTest()
    const first = fakeClient()
    await feeds.sync('host', first.client, [{ ...pane, turnStartedAt: null }], 100_000)
    first.streams[0].onFrame({ type: 'snapshot', messages: [] })
    const second = fakeClient()
    await feeds.sync('host', second.client, [{ ...pane, turnStartedAt: null }], 103_000)
    expect(first.streams[0].closed).toBe(true)
    expect(second.streams).toHaveLength(1)
    expect(feeds.covers(pane.paneKey)).toBe(false)
  })

  it('does not read again what an earlier feed of the pane read', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: 5000 }], 100_000)
    streams[0].onFrame({ type: 'snapshot', messages: [] })
    streams[0].onFrame({ type: 'appended', messages: [assistant('m1', 'Step one', 6000)] })
    streams[0].onFrame({ type: 'end' })
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: 5000 }], 111_000)
    streams[1].onFrame({
      type: 'snapshot',
      messages: [assistant('m1', 'Step one', 6000), assistant('m2', 'Step two', 7000)]
    })
    expect(spoken).toEqual(['Step one', 'Step two'])
  })

  it('takes no baseline from a snapshot of an unreadable transcript', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    streams[0].onFrame({ type: 'snapshot', messages: [], error: 'Transcript unavailable' })
    expect(feeds.covers(pane.paneKey)).toBe(false)
    streams[0].onFrame({ type: 'snapshot', messages: [assistant('old', 'Old answer')] })
    expect(feeds.covers(pane.paneKey)).toBe(true)
    expect(spoken).toEqual([])
  })

  it('hands back a final reply its feed never read, and rechecks that feed', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    streams[0].onFrame({ type: 'snapshot', messages: [] })
    const reply = { id: 'r1', paneKey: pane.paneKey, text: 'Final answer' }
    feeds.awaitReply(reply)
    expect(feeds.overdue(true)).toEqual([])
    expect(feeds.overdue(true)).toEqual([reply])
    expect(feeds.overdue(true)).toEqual([])
    streams[0].onFrame({ type: 'appended', messages: [assistant('m1', 'Final answer')] })
    expect(spoken).toEqual([])
    tabsReply.current = {
      tabs: [{ ...claudeTab, agentStatus: { agentType: 'claude', providerSession: { id: 's2' } } }]
    }
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 111_000)
    expect(streams).toHaveLength(2)
  })

  it('lets go of a held reply once its feed reads it', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    streams[0].onFrame({ type: 'snapshot', messages: [] })
    feeds.awaitReply({ id: 'r1', paneKey: pane.paneKey, text: 'Final answer' })
    streams[0].onFrame({ type: 'appended', messages: [assistant('m1', 'Final answer')] })
    expect([feeds.overdue(true), feeds.overdue(true), feeds.overdue(true)]).toEqual([[], [], []])
    expect(spoken).toEqual(['Final answer'])
  })

  it('waits before asking again for tabs it failed to read', async () => {
    const feeds = feedsUnderTest()
    const { client } = fakeClient()
    tabsRequest.mockRejectedValueOnce(new Error('offline'))
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 103_000)
    expect(tabsRequest).toHaveBeenCalledTimes(1)
  })

  it('closes the feeds of a host that is gone', async () => {
    const feeds = feedsUnderTest()
    const { client, streams } = fakeClient()
    await feeds.sync('host', client, [{ ...pane, turnStartedAt: null }], 100_000)
    feeds.keepHosts(new Set(['other-host']))
    expect(streams[0].closed).toBe(true)
  })
})
