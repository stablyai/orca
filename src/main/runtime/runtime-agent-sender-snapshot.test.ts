import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { conversationRecordReader } from './orchestration/structured-session-lineage'
import { scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session/records/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { setup, holdRead, graph, identities } from './runtime-agent-sender-snapshot.test-fixture'
import { MIRROR_LEAVES_STEP_1 } from './runtime-leaf-record-projection.test-fixture'
afterEach(() => vi.restoreAllMocks())

it('joins native snapshot R and its finite successor across graph, subscribe and delivered acknowledgements', async () => {
  const h = await setup()
  const gate = holdRead()
  const firstGraph = h.runtime.syncWindowGraph(1, graph())
  const frames: (RuntimeMobileSessionTabsResult & { type: string })[] = []
  const abort = new AbortController()
  const initialCaptured = Promise.withResolvers<void>()
  const original = h.runtime['getMobileSessionTabsForWorktreeWithChangeSequence']
  vi.spyOn(h.runtime, 'getMobileSessionTabsForWorktreeWithChangeSequence').mockImplementation(
    function (this: OrcaRuntimeService, ...args) {
      const result = original.apply(this, args)
      initialCaptured.resolve()
      return result
    }
  )
  const runtimeFrames: RuntimeMobileSessionTabsResult[] = []
  const stop = h.runtime.onMobileSessionTabsChanged((frame) => runtimeFrames.push(frame))
  const ack = vi.spyOn(h.senders, 'acknowledgeFrame')
  try {
    await gate.held
    const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: SESSION_TAB_METHODS })
    const subscribed = dispatcher.dispatchStreaming(
      {
        id: 'held-subscribe',
        authToken: 'test',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:workspace-1' }
      },
      (value) => frames.push(JSON.parse(value).result),
      { clientKind: 'runtime', connectionId: 'held', signal: abort.signal }
    )
    await initialCaptured.promise
    const peerView = h.peer.publicRead()
    await h.store.reviseSessionOptions(
      (record) => ({
        ...record,
        conversationCommand: {
          command: 'clear',
          runtimeFence: 8,
          operationId: 'clear-a',
          callerKey: 'renderer',
          phase: 'committed',
          state: 'completed',
          replacementSessionId: 'session-c'
        }
      }),
      { sessionId: 'session-a' }
    )
    await h.store.setSessionTabVisibility('session-d', true)
    await h.store.reviseSessionOptions(
      (record) => ({
        ...record,
        location: { ...record.location, workspaceId: 'workspace-2' }
      }),
      { sessionId: 'session-c' }
    )
    // Both canonical adoption and unrelated already-published memory progress before release.
    expect(h.store.getConversation('session-c')?.location.workspaceId).toBe('workspace-2')
    expect(h.peer.publicRead()).toBe(peerView)
    const secondGraph = h.runtime.syncWindowGraph(1, graph(2))
    const delivered = h.runtime['notifyMobileSessionTabSnapshots']()
    expect(
      runtimeFrames.findLast((frame) => frame.worktree === 'workspace-1')?.snapshotVersion
    ).toBe(2)
    gate.release()
    const [first, second] = await Promise.all([firstGraph, secondGraph, delivered, subscribed])
    expect(first.agentSenderAssociations?.associations.map((row) => row.identity)).toEqual([
      'orca_session_id:session-c'
    ])
    expect(second.agentSenderAssociations?.associations.map((row) => row.identity).sort()).toEqual([
      'orca_session_id:session-a',
      'orca_session_id:session-c',
      'orca_session_id:session-d'
    ])
    h.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
    const initial = frames.find((frame) => frame.type === 'snapshot')
    const update = frames.findLast((frame) => frame.type === 'updated')
    expect(initial?.snapshotVersion).toBe(1)
    expect(initial && identities(initial)).toEqual(['orca_session_id:session-c'])
    // R and R+1 each own one changed-scope touch after the version-2 structural frame.
    expect(update?.snapshotVersion).toBe(4)
    expect(update && identities(update)).toEqual(['orca_session_id:session-d'])
    expect(ack.mock.calls.findLast(([id]) => id === 'workspace-1')?.[1]).toBe(
      runtimeFrames.findLast((frame) => frame.worktree === 'workspace-1')?.agentSenderAssociations
    )
    expect(ack.mock.calls.findLast(([id]) => id === 'workspace-1')?.[1]).toEqual(
      update?.agentSenderAssociations
    )
    expect(await h.senders.changedScopes(['workspace-1', 'workspace-2'])).toEqual([])
  } finally {
    gate.release()
    stop()
    abort.abort()
    await firstGraph
  }
})

it('settles a disposed subscriber and a replaced store without publishing the held old view', async () => {
  const h = await setup()
  const gate = holdRead()
  const pending = h.senders.buildForFrame('workspace-1')
  try {
    await gate.held
    const frames: RuntimeMobileSessionTabsResult[] = []
    const stop = h.runtime.onMobileSessionTabsChanged((frame) => frames.push(frame))
    const delivery = h.runtime['notifyMobileSessionTabSnapshots']()
    stop()
    const otherRoot = await scaleDirectory()
    await seedTestAgentSessionRecordStore(otherRoot, {
      records: [scaleRecord('replacement')],
      sessionTabs: [{ sessionId: 'replacement', tabId: 'replacement-tab' }]
    })
    const replacement = await openTestAgentSessionRecordStore(otherRoot)
    h.read.mockReturnValue(conversationRecordReader(replacement))
    const successor = h.senders.build()
    gate.release()
    await Promise.all([pending, delivery])
    expect((await successor).associations.map((row) => row.identity)).toEqual([
      'orca_session_id:replacement'
    ])
    expect(frames).toHaveLength(2)
    expect((await h.senders.build()).associations.map((row) => row.identity)).toEqual([
      'orca_session_id:replacement'
    ])
  } finally {
    gate.release()
    await pending
  }
})

it('delivers a successful terminal change despite failed chat discovery and retries the same chat identity', async () => {
  const h = await setup()
  const first = await h.senders.build()
  const frames: RuntimeMobileSessionTabsResult[] = []
  const stop = h.runtime.onMobileSessionTabsChanged((frame) => frames.push(frame))
  h.runtime['notifyMobileSessionTabSnapshots']()
  frames.length = 0
  const touch = vi.spyOn(h.runtime, 'touchMobileSessionTabsForWorktree')
  const ack = vi.spyOn(h.senders, 'acknowledgeFrame')
  await h.store.setSessionTabVisibility('session-d', true)
  const gate = holdRead(true)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const pending = h.senders.build()
  let refreshed: Promise<void> | undefined
  try {
    await gate.held
    const reads = h.senders.workForTest().chatReads
    const leaf = {
      ...MIRROR_LEAVES_STEP_1[0],
      tabId: 'failed-chat-terminal',
      worktreeId: 'workspace-1',
      ptyId: 'failed-chat-pty'
    }
    h.runtime['terminalIdentity'].replaceLeaves(new Map([['failed-chat-leaf', leaf]]))
    const handle = h.runtime['issueHandle'](leaf)
    refreshed = h.runtime.refreshAgentSenderAssociations()
    expect(h.senders.workForTest().chatReads).toBe(reads)
    expect(touch).not.toHaveBeenCalled()
    expect(frames).toEqual([])
    gate.release()
    await Promise.all([pending, refreshed])
    expect(h.senders.publisher.current().associations).toEqual([
      expect.objectContaining({ identity: handle }),
      ...first.associations
    ])
    expect(warning).toHaveBeenCalled()
    expect(h.senders.workForTest().chatReads).toBe(reads)
    expect(touch.mock.calls.map(([id]) => id)).toEqual(['workspace-1'])
    h.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
    expect(frames).toHaveLength(1)
    expect(identities(frames[0])).toEqual([handle, 'orca_session_id:session-c'].sort())
    expect(ack.mock.calls[0]?.[1]).toBe(frames[0].agentSenderAssociations)
    // The owned frame is a legitimate retry wake; it never labels the failed chat key accepted.
    expect((await h.senders.build()).associations.map((row) => row.identity).sort()).toEqual(
      [handle, 'orca_session_id:session-c', 'orca_session_id:session-d'].sort()
    )
    expect(h.senders.workForTest().chatReads).toBe(reads + 1)
    h.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
    const delivered = frames.length
    await h.senders.build()
    h.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
    expect(frames).toHaveLength(delivered)
  } finally {
    gate.release()
    await Promise.all([pending, refreshed])
    stop()
  }
})

it('pairs a queued native admission with independently stamped tabs and delivers its successor', async () => {
  const h = await setup()
  const database = await openTestJournalHostDatabase(h.root)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocker = database.transaction(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const admitted = Promise.withResolvers<void>()
  const transaction = database.transaction.bind(database)
  const observe = vi.spyOn(database, 'transaction').mockImplementation((...args) => {
    const result = transaction(...args)
    admitted.resolve()
    return result
  })
  const visible = h.store.setSessionTabVisibility('session-d', true)
  await admitted.promise
  observe.mockRestore()
  // This list captures raw R while the already-admitted visibility commit still owns the queue.
  const initial = h.runtime['getMobileSessionTabsForWorktreeWithChangeSequence']('workspace-1')
  const rawSequence = h.runtime['mobileSessionTabsChangeSequence']
  const peerView = h.peer.publicRead()
  const frames: RuntimeMobileSessionTabsResult[] = []
  const stop = h.runtime.onMobileSessionTabsChanged((frame) => frames.push(frame))
  const ack = vi.spyOn(h.senders, 'acknowledgeFrame')
  try {
    release.resolve()
    await visible
    const first = await initial
    expect(first.snapshot.snapshotVersion).toBe(1)
    expect(first.changeSequence).toBe(rawSequence)
    expect(identities(first.snapshot)).toEqual([
      'orca_session_id:session-c',
      'orca_session_id:session-d'
    ])
    expect(h.peer.publicRead()).toBe(peerView)
    expect(ack).not.toHaveBeenCalled()
    // A later accepted tab frame uses the same canonical sender generation without losing it.
    await h.runtime.syncWindowGraph(1, graph(2))
    await h.runtime['notifyMobileSessionTabSnapshots']()
    const successor = frames.findLast((frame) => frame.worktree === 'workspace-1')
    expect(successor?.snapshotVersion).toBe(2)
    expect(successor && identities(successor)).toEqual(identities(first.snapshot))
    expect(successor?.agentSenderAssociations?.revision).toEqual(
      first.snapshot.agentSenderAssociations?.revision
    )
    expect(ack.mock.calls.findLast(([id]) => id === 'workspace-1')?.[1]).toBe(
      successor?.agentSenderAssociations
    )
    expect(await h.senders.changedScopes(['workspace-1'])).toEqual([])
  } finally {
    release.resolve()
    stop()
    await Promise.all([blocker, visible, initial])
  }
})
