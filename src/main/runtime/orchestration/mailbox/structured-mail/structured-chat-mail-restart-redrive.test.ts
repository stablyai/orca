import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { QueuedMessageOwed } from '../../../../native-chat/agent-session-journal/queued-messages/queued-message-consume-error'
import { eventually } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { redriveWaitingChatMail } from './structured-chat-mail-restart-redrive'

const WORKER_MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:worker', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'agent:coordinator',
    dispatchId: null,
    messages: []
  }
}

let custody: QueuedMessageOwed = 'owed'
const owesMail = { getStructuredMailSendSessions: () => [HOST_TEST_SESSION] }
let rig: QueuedMessageTestRig

beforeEach(async () => {
  vi.useFakeTimers()
  custody = 'owed'
  rig = await createQueuedMessageTestRig({
    restartable: true,
    hostDeps: { queuedAgentMessageOwed: () => custody }
  })
})

afterEach(async () => {
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function mailQueuedBeforeRestart(): Promise<string> {
  await rig.workingSend()
  const sent = await rig.send('worker report', 'queue-if-active', {
    internal: true,
    from: WORKER_MAIL
  }).result
  if (!sent.ok || !('queued' in sent.value)) {
    throw new Error('expected a queued receipt')
  }
  return sent.value.queued.messageId
}

it('hands an open idle chat the mail it walked past while a restart was restoring custody', async () => {
  const mail = await mailQueuedBeforeRestart()
  custody = 'unavailable'
  await rig.quitRestartHostProcess()
  await vi.advanceTimersByTimeAsync(250)
  expect(await rig.handoff(mail)).toBeUndefined()

  custody = 'owed'
  await vi.advanceTimersByTimeAsync(250)
  expect(await rig.handoff(mail)).toBeUndefined()
  await redriveWaitingChatMail(rig.host, owesMail, () => undefined)
  await eventually(async () => expect((await rig.handoff(mail))?.handedOverAt).toBeDefined())
})

it('opens a chat nobody has open when it holds orchestration mail, and hands that mail over', async () => {
  const mail = await mailQueuedBeforeRestart()
  await rig.quitRestartHostProcess()
  const sessions = rig.host.collaboratorsForTests().sessions
  expect(sessions.has(HOST_TEST_SESSION)).toBe(false)

  await redriveWaitingChatMail(rig.host, owesMail, () => undefined)
  await eventually(async () => {
    const journal = sessions.get(HOST_TEST_SESSION)?.journal
    const linked = await journal?.reads.input({ kind: 'linked-to', messageId: mail })
    expect(linked?.submissions.at(-1)?.handedOverAt).toBeDefined()
  })
})
