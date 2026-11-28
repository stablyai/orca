import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionMessagePayload } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'

describe('a memory save holds the chat to itself', () => {
  let rig: QueuedMessageTestRig | undefined
  afterEach(async () => {
    await rig?.dispose()
    rig = undefined
  })

  /** Opens a running turn with `origin` (memory-save) or an ordinary message. */
  async function runningTurn(memorySave: boolean): Promise<QueuedMessageTestRig> {
    rig = await createQueuedMessageTestRig()
    const current = rig
    const body = {
      ...hostTestMessage('opener'),
      ...(memorySave ? { origin: 'memory-save' as const, memorySave: { percent: 76 } } : {})
    }
    const id = hostTestOperationId()
    const fields = { body: agentSessionMessagePayload(body) }
    const sent = current.envelope(fields, 'agentSession.send', id)
    expect(
      await current.host.send(QUEUED_RIG_CALLER, { envelope: sent, ...fields, body })
    ).toMatchObject({ ok: true })
    await eventually(async () => {
      expect((await current.submission(id))?.handedOverAt).toBeDefined()
    })
    return current
  }

  async function stateOf(current: QueuedMessageTestRig, messageId: string) {
    const { queuedMessages } = (await current.host.conversation(HOST_TEST_SESSION)).journal
    return (await queuedMessages.get(messageId))?.state
  }

  it('Send now on a card during an ordinary turn hands it over (control)', async () => {
    const current = await runningTurn(false)
    const { queuedMessages } = (await current.host.conversation(HOST_TEST_SESSION)).journal
    await queuedMessages.insert({ messageId: 'owner', body: hostTestMessage('owner card') })
    expect(await current.sendNow('owner')).toMatchObject({ ok: true, value: { submission: {} } })
    expect(await stateOf(current, 'owner')).toBe('dispatched')
  })

  it('Send now on a card during a save waits for it instead of steering in', async () => {
    const current = await runningTurn(true)
    const { queuedMessages } = (await current.host.conversation(HOST_TEST_SESSION)).journal
    await queuedMessages.insert({ messageId: 'owner', body: hostTestMessage('owner card') })
    const sent = await current.sendNow('owner')
    expect(sent).toMatchObject({ ok: true, value: { queued: { messageId: 'owner' } } })
    expect(await stateOf(current, 'owner')).toBe('waiting')
    // Nothing is dropped: it is still the one card, kept to go first once the save ends.
    expect((await current.drafts()).map(({ messageId }) => messageId)).toEqual(['owner'])
  })
})
