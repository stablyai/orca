import { afterEach, expect, it } from 'vitest'
import { openAttachedHostRig, send, hello, framesOf } from './acp-structured-host.test-support'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { commandReceiptScope } from '../native-chat/agent-session-journal/command-receipt-schema'
import {
  createStructuredMailboxPointerHost,
  readStructuredSessionGateFacts
} from '../runtime/orchestration/structured-mailbox-pointer-host'
import { mintAgentSessionOperationId } from '../runtime/orchestration/structured-pointer-operation-id'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await closeProviderTimelineRigs()
})

it('queues mail without interrupting an answerable ACP question', async () => {
  const { host, rig } = await openAttachedHostRig()
  setStructuredAgentSessionHost(host)
  await send(host, 'work')
  const working = await rig.frame('session/prompt')
  const asked = rig.child().agent.request(601, 'x.ai/ask_user_question', {
    sessionId: PROVIDER_SESSION,
    toolCallId: 'question-1',
    questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }] }]
  })
  const pointer = createStructuredMailboxPointerHost()
  await waitFor(async () =>
    expect(await readStructuredSessionGateFacts(SESSION)).toMatchObject({ awaitingHuman: true })
  )
  const body: AgentJournalMessageItem = {
    ...hello,
    from: {
      kind: 'agent',
      senders: [],
      orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
    }
  }
  const before = await host.journalSnapshot(SESSION)
  const questions = before.items.filter((row) => row.body.kind === 'question')
  expect(questions).toHaveLength(1)
  const operationId = mintAgentSessionOperationId(Date.now())
  const expectedRuntimeFence = host.deps.store.getRecord(SESSION)!.lease.runtimeFence
  expect(
    await pointer.send({
      sessionId: SESSION,
      dispatchId: null,
      operationId,
      expectedRuntimeFence,
      body,
      beforeRun: () => {},
      mailSource: { incarnation: 'source', sequence: 1, origin: 'local' }
    })
  ).toEqual({ kind: 'queued' })
  const after = await host.journalSnapshot(SESSION)
  expect(before.submissions).toHaveLength(1)
  expect(after.submissions).toEqual(before.submissions)
  expect(after.items.filter((row) => row.body.kind === 'question')).toEqual(questions)
  expect(await readStructuredSessionGateFacts(SESSION)).toMatchObject({ awaitingHuman: true })
  expect(
    host.deps.store.readCommandReceipt(commandReceiptScope('any', 'global'), operationId)
  ).toMatchObject({
    verdict: 'readable',
    receipt: { status: 'accepted', result: { kind: 'queued-draft', messageId: operationId } }
  })
  expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
  const question = questions[0]!
  const fields = {
    itemId: question.itemId,
    expectedRevision: question.revision,
    answers: [{ questionId: 'q1', optionIds: ['o1'] }]
  }
  expect(
    await host.respondToPrompt(CALLER, {
      ...fields,
      kind: 'question',
      envelope: envelope('agentSession.respondTo:question', fields)
    })
  ).toMatchObject({ ok: true })
  expect(await asked).toMatchObject({
    result: { outcome: 'accepted', answers: { 'Which file?': 'a.ts' } }
  })
  expect((await host.journalSnapshot(SESSION)).submissions).toEqual(before.submissions)
  expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
  rig.child().agent.reply(working, { stopReason: 'end_turn' })
  const report = await rig.frame('session/prompt', 1)
  const submission = (await host.journalSnapshot(SESSION)).submissions.find(
    (row) => row.queuedMessageId === operationId
  )
  expect(submission).toBeDefined()
  expect(submission?.clientMessageId).not.toBe(operationId)
  expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(2)
  rig.child().agent.reply(report, { stopReason: 'end_turn' })
  await waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).items.filter(
        (row) => row.body.kind === 'turn' && row.body.state === 'completed'
      )
    ).toHaveLength(2)
  )
  expect(
    (await host.journalSnapshot(SESSION)).items.find((row) => row.itemId === question.itemId)?.body
  ).toMatchObject({ kind: 'question', resolution: { state: 'resolved', answers: fields.answers } })
  await host.close(SESSION, 'user-close')
})
