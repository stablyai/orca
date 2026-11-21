import { expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalThreadGoalStatus
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { unhandledProviderFrameJournalItem } from '../../providers/unhandled-provider-frame'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend
} from './structured-agent-session-rest-test-rig.test-fixture'

it('announces a Codex goal once, after its automatic turns stop', async () => {
  const rig = await createRestTestRig()
  try {
    const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    if (!attached.ok) {
      throw new Error(`attach refused: ${attached.refusal.code}`)
    }
    const events: AgentSessionTurnCompletionEvent[] = []
    rig.host.subscribeTurnCompletions({ id: 'notifications', emit: (event) => events.push(event) })
    const send = restTestSend('finish the migration', attached.fence)
    expect(await rig.host.send(REST_TEST_CALLER, send)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
    const request = rig.adapter.dispatch.mock.calls[0]![0]
    const dispatched = await rig.adapter.dispatch.mock.results[0]!.value
    if (dispatched.state !== 'accepted' || dispatched.providerIdentity.provider !== 'codex') {
      throw new Error('the send was not accepted by Codex')
    }
    const provider = rig.adapter.acquire.mock.calls.at(-1)![0].events!
    const { threadId } = dispatched.providerIdentity
    let ordinal = 100
    const append = async (turnId: string, body: Parameters<typeof provider.appendItem>[1]) => {
      ordinal += 1
      provider.appendItem({ provider: 'codex', threadId, turnId, ordinal }, body, {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
    }
    const goal = (turnId: string, status: AgentJournalThreadGoalStatus) => {
      const goalRow = unhandledProviderFrameJournalItem(
        'codex',
        'notification:thread/goal/updated',
        {
          threadId,
          turnId,
          goal: {
            threadId,
            objective: 'finish the migration',
            status,
            tokenBudget: null,
            tokensUsed: 10,
            timeUsedSeconds: 30,
            createdAt: 1789067988,
            updatedAt: 1789067988
          }
        }
      )
      return append(turnId, goalRow!.body)
    }
    // The completion feed sees each status the host publishes, so this pins every turn edge.
    const published = (status: 'working' | 'idle') =>
      vi.waitFor(() => expect(rig.host.readStatusSummary(HOST_TEST_SESSION)?.status).toBe(status))
    const turn = async (turnId: string, userItemId?: string) => {
      const body = { kind: 'turn' as const, turnId, ...(userItemId ? { userItemId } : {}) }
      await append(turnId, { ...body, state: 'running' })
      await published('working')
      await append(turnId, { ...body, state: 'completed', outcome: 'success' })
      await published('idle')
    }

    const first = dispatched.providerIdentity.turnId
    await goal(first, 'active')
    await turn(first, agentJournalSubmissionKey(request.clientMessageId))
    await turn('continuation')
    await goal('continuation', 'complete')

    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'completion')).not.toHaveLength(0)
    )
    expect(events).toEqual([
      expect.objectContaining({
        type: 'completion',
        completion: expect.objectContaining({ turnId: 'continuation', outcome: 'success' })
      })
    ])
  } finally {
    await rig.dispose()
  }
})
