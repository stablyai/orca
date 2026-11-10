import {
  appendTestJournalQueueRow,
  openTestJournalHostDatabase
} from '../../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

import { finishTestJournalHistoricalInputs } from '../../../../../native-chat/agent-session-journal/replay/journal-historical-inputs.test-support'
import 'node:fs/promises'
import 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'

import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import '../../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { call } from '../protocol/structured-agent-session-rpc.test-fixture'

import { STRUCTURED_MOBILE_CLIENT } from '../protocol/structured-agent-session-rpc-client.test-fixture'
import './structured-agent-session-queued-image-capability'
import '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

const OLD = { ...STRUCTURED_MOBILE_CLIENT, clientId: 'old-phone', connectionId: 'old-phone' }
let rig: QueuedMessageTestRig | undefined

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

it('keeps a saved physical hold independent while its own rejected retry blocks the ordered suffix', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, legacyInputs: true })
  setStructuredAgentSessionHost(rig.host)
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Complete immutable original.' }]
  }
  const id = hostTestOperationId()
  const send = { body, options: { model: 'default' } }
  expect(
    await call(
      'agentSession.send',
      { envelope: rig.envelope(send, 'agentSession.send', id), ...send },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(1))
  for (const text of ['First complete waiting input.', 'Second complete waiting input.']) {
    const fields = {
      body: { ...body, blocks: [{ type: 'text', text }] },
      delivery: 'queue-if-active',
      options: { model: 'default' }
    }
    expect(
      await call(
        'agentSession.send',
        { envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()), ...fields },
        OLD
      )
    ).toMatchObject({ result: { ok: true } })
  }
  await rig.stop()
  await rig.host.flushStreamedEvents(SESSION)
  const j = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const saved = `recovery:${id}`
  appendTestJournalQueueRow(openTestJournalHostDatabase(rig.root).db, j, saved, {
    op: 'queued',
    body,
    recovers: id,
    position: -1,
    queuedAt: j.cursor(),
    options: { model: 'default' },
    returned: { reason: 'prior-build uncertainty', rejection: { kind: 'unconfirmed' } }
  })
  finishTestJournalHistoricalInputs(j)
  async function published() {
    const rpc = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD)
    if (!rpc.ok) {
      throw new Error('history refused')
    }
    return rpc.result
  }
  const held = await published()
  expect(held).toHaveProperty('page.queuedMessages', [
    { messageId: saved, position: -1, body, state: 'waiting', paused: true },
    ...j.queuedMessages
      .list()
      .filter((row) => row.messageId !== saved)
      .map((row) => ({
        messageId: row.messageId,
        position: row.position,
        body: row.body,
        state: 'waiting'
      }))
  ])
  const immutable = j.submission(id)
  const receipt = j.receiptFor(id)
  await rig.quitRestartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  rig.failNextStart(new Error('saved choice own retry failed'))
  const fields = { messageId: saved }
  const params = {
    envelope: rig.envelope(fields, 'agentSession.queuedMessageSend', hostTestOperationId()),
    ...fields
  }
  expect(await call('agentSession.queuedMessageSend', params, OLD)).toMatchObject({
    result: { ok: true }
  })
  await eventually(async () => expect((await rig!.handoff(saved))?.dispatchState).toBe('rejected'))
  const rejected = await published()
  const state = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const physical = state.queuedMessages.get(saved)!
  expect(physical.state).toBe('returned')
  expect(physical.recovers).toBe(id)
  expect(physical.consumedAs).not.toBe(id)
  expect(rejected).toHaveProperty('page.nextQueuedMessageId', null)
  expect(rejected).toHaveProperty('page.queuedMessages.0.state', 'returned')
  expect(await call('agentSession.queuedMessageSend', params, OLD)).toMatchObject({
    result: { ok: true, replayed: true }
  })
  expect(
    await call(
      'agentSession.queuedMessagesResume',
      { envelope: rig.envelope({}, 'agentSession.queuedMessagesResume', hostTestOperationId()) },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
  await published()
  await rig.settleAccepted(id, 'original-positive-proof-independent-of-failed-retry')
  expect(state.queuedMessages.get(saved)).toStrictEqual(physical)
  expect(state.submissionBody(id)).toStrictEqual(body)
  expect(state.submission(id)?.payloadFingerprint).toBe(immutable?.payloadFingerprint)
  expect(state.receiptFor(id)).not.toEqual(receipt)
  await published()
})
