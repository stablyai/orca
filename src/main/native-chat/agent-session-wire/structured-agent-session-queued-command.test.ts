// Queued drafts across conversation commands: a /compact is a queued message
// and then a turn, so a capable send during it becomes a card that waits for it
// like any turn, while Delete and Send-now answer at once; a /clear in flight
// admits no draft onto the source it is superseding; and a draft /clear carries
// to its replacement is fingerprinted for the replacement, so the provider's
// echo folds into its sent bubble.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_THREAD as THREAD,
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
  it('in flight, refuses a capable send as today: no card lands on the source it supersedes', async () => {
    const attach = rig.host.attach.bind(rig.host)
    let release: (() => void) | undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = vi.spyOn(rig.host, 'attach').mockImplementationOnce(async (...args) => {
      await released
      return attach(...args)
    })
    try {
      const cleared = command('clear')
      // Nothing is recorded before the clear commits; wait until it is starting the replacement.
      await eventually(() => expect(spy).toHaveBeenCalled())
      expect(await rig.send('sent while clearing', 'queue-if-active').result).toEqual(WAIT_REFUSAL)
      release?.()
      const done = await cleared
      const replacementId = done.ok ? done.value.replacementSessionId : undefined
      if (!replacementId) {
        throw new Error('expected a replacement session')
      }
      expect(await rig.drafts()).toHaveLength(0)
      expect(await rig.drafts(replacementId)).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("a carried draft sent on the replacement: the provider's echo folds into its one bubble", async () => {
    const working = await rig.workingSend()
    const draftId = await queuedId(rig.send('carried text', 'queue-if-active').result)
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const cleared = await command('clear')
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.sendNow(draftId, hostTestOperationId(), replacementId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    const journal = rig.host.collaboratorsForTests().sessions.get(replacementId)?.journal
    const sent = journal?.submissions().findLast((entry) => entry.queuedMessageId === draftId)
    if (!journal || !sent) {
      throw new Error('expected the carried draft sent on the replacement')
    }
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-echo', ordinal: 0 },
      hostTestMessage('carried text'),
      { fence: sent.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const snapshot = await rig.host.journalSnapshot(replacementId)
    const userBubbles = snapshot.items.filter(
      (item) => item.body.kind === 'message' && item.body.role === 'user'
    )
    expect(userBubbles).toHaveLength(1)
    expect(snapshot.submissions.find((entry) => entry.queuedMessageId === draftId)).toMatchObject({
      dispatchState: 'accepted'
    })
  })
})
