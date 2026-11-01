import { afterEach, expect, it } from 'vitest'
import { openAttachedHostRig, send, hello, framesOf } from './acp-structured-host.test-support'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { createStructuredMailboxPointerHost } from '../runtime/orchestration/structured-mailbox-pointer-host'
import { mintAgentSessionOperationId } from '../runtime/orchestration/structured-pointer-operation-id'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await closeProviderTimelineRigs()
})

it('queues mail behind an answerable ACP question without interrupting it', async () => {
  const { host, rig } = await openAttachedHostRig()
  setStructuredAgentSessionHost(host)
  await send(host, 'work')
  await rig.frame('session/prompt')
  void rig.child().agent.request(601, 'x.ai/ask_user_question', {
    sessionId: PROVIDER_SESSION,
    toolCallId: 'question-1',
    questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }] }]
  })
  const pointer = createStructuredMailboxPointerHost()
  await waitFor(() => expect(host.currentWork(SESSION)?.hasActionablePrompt()).toBe(true))
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
      stillOwed: () => true
    })
  ).toEqual({ kind: 'queued' })
  const after = await host.journalSnapshot(SESSION)
  expect(before.submissions).toHaveLength(1)
  expect(after.submissions).toEqual(before.submissions)
  expect(after.items.filter((row) => row.body.kind === 'question')).toEqual(questions)
  expect(host.currentWork(SESSION)?.hasActionablePrompt()).toBe(true)
  expect(await pointer.observe(SESSION, operationId)).toBe('waiting')
  expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
  await host.close(SESSION, 'user-close')
})
