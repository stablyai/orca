import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { chatAwaitsResume } from './external-conversation-resume'

// Resume from a thread continues a chat only while its newest turn is the failed one: a stale or
// repeated press, after the chat was resumed in Orca or ran again, must not send a second continue.
let rig: QueuedMessageTestRig | null = null
afterEach(async () => {
  await rig?.dispose()
  rig = null
})

async function failedTurn(chat: QueuedMessageTestRig): Promise<void> {
  const id = await chat.workingSend()
  const turnId = `turn-${id}`
  await chat.settleAccepted(id, id)
  chat
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId, ordinal: 1 },
      { kind: 'turn', turnId, state: 'completed', outcome: 'failure', userItemId: `orca:${id}` },
      { turnScope: { kind: 'thread' } }
    )
  chat.providerEvents().publish()
  // The failure reaches the journal after the provider event; wait for the chat to show it.
  await eventually(async () => expect(await chatAwaitsResume(chat.host, SESSION)).toBe(true))
}

describe('chatAwaitsResume', () => {
  it('holds after a failed turn and lets go once Orca resumes the chat', async () => {
    rig = await createQueuedMessageTestRig()
    expect(await chatAwaitsResume(rig.host, SESSION)).toBe(false)
    await failedTurn(rig)
    expect(await chatAwaitsResume(rig.host, SESSION)).toBe(true)
    expect(await rig.resume()).toMatchObject({ ok: true })
    expect(await chatAwaitsResume(rig.host, SESSION)).toBe(false)
  })

  // A person's send (a thread's Resume is one) runs at once rather than waiting behind the pause.
  it('lets go once someone sends in the chat after the failure', async () => {
    rig = await createQueuedMessageTestRig()
    await failedTurn(rig)
    expect(await chatAwaitsResume(rig.host, SESSION)).toBe(true)
    await rig.send('try it this way').result
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
    expect(await rig.drafts()).toEqual([])
    await eventually(async () => expect(await chatAwaitsResume(rig!.host, SESSION)).toBe(false))
  })
})
