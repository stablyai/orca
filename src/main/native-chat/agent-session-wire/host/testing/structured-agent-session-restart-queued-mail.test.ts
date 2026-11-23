import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { QueuedMessageOwed } from '../../../agent-session-journal/queued-messages/queued-message-consume-error'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredQueuePauses } from '../../delivery/structured-agent-session-queued-pause'
import { HOST_TEST_SESSION, HOST_TEST_THREAD } from './structured-agent-session-host-test-data.test-fixture'
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

let custody: QueuedMessageOwed = 'owed'
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

/** The send's turn row as the provider writes it: running, then completed. */
async function turnFor(id: string, state: 'running' | 'completed'): Promise<void> {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const turnId = `turn-of-${id}`
  await journal.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId, ordinal: 0 },
    {
      kind: 'turn',
      turnId,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(id),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() })
    },
    {
      fence: rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

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
    await rig.settleAccepted(await rig.handoffId(mail), 'mail')
    await vi.advanceTimersByTimeAsync(250)
    expect(await rig.handoff(personal)).toBeUndefined()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    expect((await structuredQueuePauses(journal)).map((pause) => pause.reason)).toEqual([
      'restarted'
    ])
  })

  it('opening an idle chat hands over agent mail its queue walked past while custody was unreadable', async () => {
    const working = await rig.workingSend()
    await turnFor(working, 'running')
    await rig.settleAccepted(working, 'working')
    custody = 'unavailable'
    const mail = await queued('worker report', WORKER_MAIL)
    await turnFor(working, 'completed')
    await vi.advanceTimersByTimeAsync(250)
    expect(await rig.handoff(mail)).toBeUndefined()

    await rig.quitRestartHostProcess()
    custody = 'owed'

    await eventually(async () => expect((await rig.handoff(mail))?.handedOverAt).toBeDefined())
  })
})
