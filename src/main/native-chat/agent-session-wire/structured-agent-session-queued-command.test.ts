import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

const WAIT_REFUSAL = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { reason: 'conversationCommandInFlight' },
    message: 'Wait for the conversation operation to finish.'
  }
}

function command(name: 'compact' | 'clear') {
  const fields = { command: name }
  return rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
}

async function queuedId(
  result: ReturnType<QueuedMessageTestRig['send']>['result']
): Promise<string> {
  const queued = await result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

describe('a /compact in flight', () => {
  /** A /compact the provider took: a queued message, then its own turn, running until the
   *  provider ends it (`finishCompact`). */
  async function compactRunning(): Promise<void> {
    expect(await command('compact')).toMatchObject({ ok: true, value: { command: 'compact' } })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  }

  it('turns a capable send into a card, which waits for the compaction and then drains', async () => {
    await compactRunning()
    const draftId = await queuedId(rig.send('sent while compacting', 'queue-if-active').result)
    expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    // The compaction's turn owes work, so the drain waits behind it like any turn.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await rig.handoff(draftId)).toBeUndefined()
    rig.finishCompact()
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    expect(await rig.drafts()).toHaveLength(0)
  })

  it('answers Delete at once, and Send-now sends its card behind the compaction like any send', async () => {
    await compactRunning()
    const deletedId = await queuedId(rig.send('deleted while compacting', 'queue-if-active').result)
    const sentId = await queuedId(rig.send('sent now while compacting', 'queue-if-active').result)
    const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000))
    // Nothing holds the session's lane for the compaction's length any more.
    expect(await Promise.race([rig.deleteQueued(deletedId), hung])).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    expect(await Promise.race([rig.sendNow(sentId), hung])).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: sentId } }
    })
    // Accepted, then handed over only once the compaction ends — the order every send keeps.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(rig.dispatch).toHaveBeenCalledTimes(0)
    rig.finishCompact()
    await eventually(async () => expect((await rig.handoff(sentId))?.handedOverAt).toBeDefined())
  })
})

describe('/clear', () => {
  it('refuses a send arriving while clear is stopping the context', async () => {
    let release: (() => void) | undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const stopping = vi.fn()
    const spy = rig.closeSession.mockImplementationOnce(async () => {
      stopping()
      await released
      return true
    })
    try {
      const cleared = command('clear')
      await eventually(() => expect(stopping).toHaveBeenCalledOnce())
      const sent = rig.send('sent while clearing', 'queue-if-active').result
      release?.()
      expect(await sent).toEqual(WAIT_REFUSAL)
      expect(await cleared).toMatchObject({ ok: true, value: { command: 'clear' } })
      expect(await rig.drafts()).toHaveLength(0)
    } finally {
      release?.()
      spy.mockResolvedValue(true)
    }
  })

  it('keeps waiting card identities and starts a fresh context ahead of their drain', async () => {
    const working = await rig.workingSend()
    const firstId = await queuedId(rig.send('first draft', 'queue-if-active').result)
    const secondId = await queuedId(rig.send('second draft', 'queue-if-active').result)
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    expect(await command('clear')).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION)?.providerHandleChain).toEqual([])
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null).toBeNull()
    expect(await rig.drafts()).toEqual([
      { messageId: firstId, state: 'waiting' },
      { messageId: secondId, state: 'waiting' }
    ])
    expect(await rig.handoff(firstId)).toBeUndefined()
    const sent = rig.send('first in the new context', 'queue-if-active')
    expect(await sent.result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    await eventually(() =>
      expect(rig.store.getRecord(SESSION)?.providerHandleChain).toHaveLength(1)
    )
    await eventually(() =>
      expect(activeProviderContext(rig.store.getRecord(SESSION)!).head).not.toBeNull()
    )
    const thread = activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle.nativeId
    await rig.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: sent.id,
      providerIdentity: { provider: 'codex', threadId: thread, turnId: 'turn-first', ordinal: 0 }
    })
    await eventually(async () => expect(await rig.handoff(firstId)).toBeDefined())
    expect(await rig.queuePause()).toBeNull()
  })

  it('compacts the new context without removing clear ancestry or its divider', async () => {
    expect(await command('clear')).toMatchObject({ ok: true })
    const boundary = rig.store.getRecord(SESSION)!.providerContextBoundary
    expect(await command('compact')).toMatchObject({ ok: true })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(activeProviderContext(rig.store.getRecord(SESSION)!).head?.replaces).toBeUndefined()
    expect(rig.store.getRecord(SESSION)!.providerHandleChain).toHaveLength(1)
    rig.finishCompact()
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await eventually(() =>
      expect(rig.store.getRecord(SESSION)?.conversationCommand?.state).toBe('completed')
    )
    expect(rig.store.getRecord(SESSION)!.providerContextBoundary).toEqual(boundary)
    expect(journal.context.floor()).not.toBeNull()
  })

  it('a waiting card sent after clear gets one provider echo bubble in that context', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedId(rig.send('waiting text', 'queue-if-active').result)
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    expect(await command('clear')).toMatchObject({ ok: true })
    expect(await rig.sendNow(draftId, hostTestOperationId())).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const sent = journal.submissions().findLast((entry) => entry.queuedMessageId === draftId)!
    await eventually(() =>
      expect(activeProviderContext(rig.store.getRecord(SESSION)!).head).not.toBeNull()
    )
    const thread = activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle.nativeId
    await journal.appendItem(
      { provider: 'codex', threadId: thread, turnId: 'turn-echo', ordinal: 0 },
      hostTestMessage('waiting text'),
      { fence: sent.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const floor = journal.context.floor()!.sequence
    expect(
      journal
        .snapshot()
        .items.filter(
          (item) =>
            item.sequence > floor && item.body.kind === 'message' && item.body.role === 'user'
        )
    ).toHaveLength(1)
    expect(journal.submission(sent.clientMessageId)?.dispatchState).toBe('accepted')
  })
})
