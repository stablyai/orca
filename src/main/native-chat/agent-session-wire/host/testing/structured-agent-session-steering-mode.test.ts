import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { CLAUDE_STRUCTURED_AGENT } from '../../../../claude/structured/claude-structured-agent-definition'
import { structuredAgentsDeclaringNothing } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'term_b', dispatchId: null, messages: [] }
}

function queueDeclaredClaudeRegistry() {
  return structuredAgentsDeclaringNothing([
    {
      ...CLAUDE_STRUCTURED_AGENT,
      capabilities: { ...CLAUDE_STRUCTURED_AGENT.capabilities, steering: 'queue' }
    }
  ])
}

async function writeTurn(
  target: QueuedMessageTestRig,
  clientMessageId: string,
  state: 'running' | 'completed'
) {
  const journal = target.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await journal.appendItem(
    { provider: 'claude', sessionId: THREAD, uuid: `turn-of-${clientMessageId}` },
    {
      kind: 'turn',
      turnId: `turn-of-${clientMessageId}`,
      startedAt: HOST_TEST_NOW,
      userItemId: agentJournalSubmissionKey(clientMessageId),
      ...(state === 'running' ? { state } : { state, completedAt: HOST_TEST_NOW })
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

async function openRunningTurn(target: QueuedMessageTestRig, clientMessageId: string) {
  await target.settleAccepted(clientMessageId, 'working')
  await writeTurn(target, clientMessageId, 'running')
}

describe('per-session steeringMode for orchestration mail', () => {
  it('delivers orchestration mail into a running turn when the live child steers by inject', async () => {
    rig = await createQueuedMessageTestRig({
      agent: 'claude',
      hostDeps: { agents: queueDeclaredClaudeRegistry() }
    })
    const adapter = rig.host.collaboratorsForTests().deps.adapter
    adapter.steeringMode = () => 'inject'

    const working = await rig.workingSend()
    await openRunningTurn(rig, working)

    const queued = await rig.send('worker update', 'queue-if-active', {
      internal: true,
      from: MAIL
    }).result
    expect(queued).toMatchObject({ ok: true })

    await eventually(() => {
      expect(rig.dispatch).toHaveBeenCalledTimes(2)
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('holds orchestration mail until the turn ends when the live child steers by queue', async () => {
    rig = await createQueuedMessageTestRig({
      agent: 'claude',
      hostDeps: { agents: queueDeclaredClaudeRegistry() }
    })
    const adapter = rig.host.collaboratorsForTests().deps.adapter
    adapter.steeringMode = () => 'queue'

    const working = await rig.workingSend()
    await openRunningTurn(rig, working)

    const queued = await rig.send('worker update', 'queue-if-active', {
      internal: true,
      from: MAIL
    }).result
    expect(queued).toMatchObject({ ok: true })

    expect(await rig.drafts()).toHaveLength(1)
    expect(rig.dispatch).toHaveBeenCalledTimes(1)

    await writeTurn(rig, working, 'completed')
    await eventually(() => {
      expect(rig.dispatch).toHaveBeenCalledTimes(2)
    })
    expect(await rig.drafts()).toEqual([])
  })
})
