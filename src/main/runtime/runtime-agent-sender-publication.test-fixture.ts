import { expect, vi } from 'vitest'
import { setup, holdRead, identities, snapshot } from './runtime-agent-sender-snapshot.test-fixture'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { RuntimeAgentSenderPublicationTestModule } from '../../shared/runtime-agent-sender-consumer.test-fixture'
import { MIRROR_LEAVES_STEP_1 } from './runtime-leaf-record-projection.test-fixture'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'

async function verifyHeldSenderPublication(
  consume: Parameters<RuntimeAgentSenderPublicationTestModule['verifyHeldSenderPublication']>[0]
) {
  const h = await setup()
  const leaf = {
    ...MIRROR_LEAVES_STEP_1[0],
    tabId: 'sender-tab',
    worktreeId: 'workspace-1',
    ptyId: 'sender-pty'
  }
  let pty = makeTuiIdlePty({
    ptyId: 'sender-pty',
    incarnationId: 'first',
    worktreeId: 'workspace-1'
  })
  const deps = h.senders['deps']
  vi.spyOn(deps, 'getLeaves').mockImplementation(() => [leaf])
  vi.spyOn(deps, 'getPtys').mockImplementation(() => [pty])
  vi.spyOn(deps, 'readLeafHandle').mockReturnValue('term_sender')
  vi.spyOn(deps, 'makePaneKey').mockReturnValue('sender-tab:11111111-1111-4111-8111-111111111111')
  const initial = await h.senders.build()
  expect(initial.associations.some((row) => row.identity === 'term_sender')).toBe(true)
  const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: SESSION_TAB_METHODS })
  const frames: (RuntimeMobileSessionTabsResult & { removed?: true; type: string })[] = []
  const abort = new AbortController()
  await dispatcher.dispatchStreaming(
    { id: 'held-inventory', authToken: 'test', method: 'session.tabs.subscribeAll' },
    (value) => {
      const frame = JSON.parse(value)
      if (frame.result) {
        frames.push(frame.result)
      }
    },
    { clientKind: 'runtime', connectionId: 'held-inventory', signal: abort.signal }
  )
  const desktop: RuntimeMobileSessionTabsResult[] = []
  const phone: RuntimeMobileSessionTabsResult[] = []
  const stop = h.runtime.onMobileSessionTabsChanged((frame) => desktop.push(frame))
  const stopPhone = h.runtime.onMobileSessionTabsChanged(
    (frame) => phone.push(frame),
    undefined,
    'mobile'
  )
  const ack = vi.spyOn(h.senders, 'acknowledgeFrame')
  const gate = holdRead()
  let pending: ReturnType<typeof h.senders.build> | undefined
  try {
    await h.store.reviseSessionOptions(
      (record) => ({ ...record, location: { ...record.location, workspaceId: 'workspace-2' } }),
      { sessionId: 'session-d' }
    )
    await h.store.setSessionTabVisibility('session-d', true)
    pending = h.senders.build()
    await gate.held
    pty = { ...pty, incarnationId: 'respawned' }
    h.runtime['notifyMobileSessionTabSnapshots']()
    const immediate = desktop.findLast((frame) => frame.worktree === 'workspace-1')!
    expect(identities(immediate)).not.toContain('term_sender')
    consume('immediate', immediate)
    expect(phone).toHaveLength(2)
    expect(phone.every((frame) => !frame.agentSenderAssociations)).toBe(true)
    expect(ack.mock.calls.findLast(([id]) => id === 'workspace-1')?.[1]).toBe(
      immediate.agentSenderAssociations
    )
    h.runtime['mobileSessionTabsByWorktree'].delete('workspace-1')
    h.runtime['notifyMobileSessionTabsRemoved']('workspace-1')
    const removedAt = frames.length
    const acknowledgements = ack.mock.calls.filter(([id]) => id === 'workspace-1').length
    const staleInitial = expect(
      h.runtime['getMobileSessionTabsForWorktreeWithChangeSequence']('workspace-2')
    ).rejects.toThrow('session_tabs_inventory_unstable')
    h.runtime.syncWindowGraph(
      1,
      {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          { ...snapshot('workspace-2', 3), publicationEpoch: 'recreated-sender-snapshot' }
        ]
      },
      { includeAgentSenders: false }
    )
    h.runtime['notifyMobileSessionTabSnapshots']()
    const recreated = desktop.findLast((frame) => frame.worktree === 'workspace-2')!
    expect(identities(recreated)).not.toContain('orca_session_id:session-d')
    const chatReads = h.senders.workForTest().chatReads
    gate.release()
    await pending
    await staleInitial
    await h.senders.build()
    h.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
    expect(frames.slice(removedAt).some((frame) => frame.worktree === 'workspace-1')).toBe(false)
    expect(ack.mock.calls.filter(([id]) => id === 'workspace-1')).toHaveLength(acknowledgements)
    expect(
      h.senders.publisher.current().associations.some((row) => row.identity === 'term_sender')
    ).toBe(false)
    expect(frames.some((frame) => frame.worktree === 'workspace-1' && frame.removed)).toBe(true)
    const successor = desktop.findLast((frame) => frame.worktree === 'workspace-2')!
    expect(successor.publicationEpoch).toBe('recreated-sender-snapshot')
    expect(successor.snapshotVersion).toBe(4)
    expect(identities(successor)).toEqual(['orca_session_id:session-d'])
    expect(h.senders.workForTest().chatReads).toBe(chatReads)
    consume('successor', successor)
    const before = desktop.length
    await h.senders.build()
    h.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
    expect(desktop).toHaveLength(before)
    h.runtime.syncWindowGraph(
      1,
      { tabs: [], leaves: [], mobileSessionTabs: [snapshot('workspace-1', 3)] },
      { includeAgentSenders: false }
    )
    h.runtime['notifyMobileSessionTabSnapshots']()
    expect(frames.findLast((frame) => frame.worktree === 'workspace-1')).toMatchObject({
      snapshotVersion: 3
    })
  } finally {
    gate.release()
    await pending
    stop()
    stopPhone()
    abort.abort()
  }
}
export default { verifyHeldSenderPublication } satisfies RuntimeAgentSenderPublicationTestModule
