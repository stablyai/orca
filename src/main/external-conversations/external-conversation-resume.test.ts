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
import type { ConversationChatHost } from './external-conversation-chat'
import { resumeRefusal } from './external-conversation-resume'

// Resume from a thread continues a chat only while its newest turn is the failed one: a stale or
// repeated press, after the chat was resumed in Orca or ran again, must not send a second continue.
const OWNED = { probeOwner: async () => ({ outcome: 'pid-absent' as const }) }
let rig: QueuedMessageTestRig | null = null
afterEach(async () => {
  await rig?.dispose()
  rig = null
})

// The chat host as the seam reads it; `installed: false` is one not yet installed since a restart.
const hostOf = (chat: QueuedMessageTestRig, installed = true): ConversationChatHost => ({
  current: () => (installed ? chat.host : null),
  ensure: async () => chat.host,
  onChanged: () => () => {}
})
const resume = (chat: QueuedMessageTestRig, installed = true) =>
  resumeRefusal({ resume: true }, hostOf(chat, installed), SESSION)
const NOT_FAILED = { outcome: 'refused', reason: 'not_failed' }

// What the chat holds, for a failure message.
async function seen(chat: QueuedMessageTestRig): Promise<string> {
  const holds = await (
    await chat.host.conversation(SESSION)
  ).journal.queuedMessages
    .failureHolds()
    .catch((error: unknown) => String(error))
  const work = await chat.host.currentWork(SESSION)
  const page = await chat.host.history({ sessionId: SESSION, direction: 'tail' })
  return JSON.stringify({
    holds,
    working: work?.working(),
    prompt: work?.hasActionablePrompt(),
    items: page.ok ? page.page.items.map((item) => item.body) : page
  })
}

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
  // The queue's failure read is the journal database's: let the turn's write land there first.
  await chat.providerEvents().written?.()
  await eventually(async () => expect(await resume(chat), await seen(chat)).toBeNull())
}

describe('resumeRefusal', () => {
  it('lets a failed chat resume once, then refuses after Orca resumed it', async () => {
    rig = await createQueuedMessageTestRig(OWNED)
    expect(await resume(rig)).toMatchObject(NOT_FAILED)
    await failedTurn(rig)
    // A host not yet installed since a restart is installed, not taken as moved on.
    expect(await resume(rig, false)).toBeNull()
    expect(await rig.resume()).toMatchObject({ ok: true })
    expect(await resume(rig)).toMatchObject(NOT_FAILED)
  })

  // A person's send (a thread's Resume is one) runs at once rather than waiting behind the pause.
  it('refuses once someone sends in the chat after the failure', async () => {
    rig = await createQueuedMessageTestRig(OWNED)
    await failedTurn(rig)
    await rig.send('try it this way').result
    expect(await resume(rig)).toMatchObject(NOT_FAILED)
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
    expect(await rig.drafts()).toEqual([])
  })
})
