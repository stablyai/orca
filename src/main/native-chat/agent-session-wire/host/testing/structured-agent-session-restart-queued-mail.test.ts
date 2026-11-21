import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { structuredQueuePauses } from '../../delivery/structured-agent-session-queued-pause'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const WORKER_MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:worker', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'agent:coordinator', dispatchId: null, messages: [] }
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  vi.useFakeTimers()
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function queued(text: string, from?: AgentMessageSource): Promise<string> {
  const sent = await rig.send(text, 'queue-if-active', from ? { internal: true, from } : undefined)
    .result
  if (!sent.ok || !('queued' in sent.value)) {
    throw new Error('expected a queued receipt')
  }
  return sent.value.queued.messageId
}

describe('an idle chat after a restart', () => {
  it("delivers agent mail queued before it, while the person's own card stays held", async () => {
    await rig.workingSend()
    const personal = await queued('my follow-up')
    const mail = await queued('worker report', WORKER_MAIL)

    await rig.quitRestartHostProcess()

    await eventually(async () => expect((await rig.handoff(mail))?.handedOverAt).toBeDefined())
    expect(await rig.handoff(personal)).toBeUndefined()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    expect((await structuredQueuePauses(journal)).map((pause) => pause.reason)).toEqual([
      'restarted'
    ])
  })
})
