import '../unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  createQueuedMessageTestRig,
  eventually
} from '../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../../../shared/structured-agent-session-send-mutation'
import {
  AUTOMATION_AGENT_CALLER,
  automationRunOperationId
} from '../../../automations/automation-run-operation'
import { AUTOMATION_RUN_REPORT_GRACE_MS } from '../../../../shared/automation-run-results'
import { NOT_IN_AUTOMATION_RUN_MESSAGE } from '../../../automations/automation-run-caller'
import { buildProfileStateCutoverFixture } from '../../../persistence/profile-state-cutover-fixture'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import { OrcaRuntimeService } from '../../orca-runtime'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { RpcDispatcher } from '../dispatcher'
import { AUTOMATION_RUN_RESULT_METHODS } from './automation-run-results'

const hostRef = vi.hoisted((): { current: StructuredAgentSessionHost | null } => ({
  current: null
}))
vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

afterEach(() => {
  hostRef.current = null
  vi.restoreAllMocks()
})

it('attributes overlapping chat reports to submitted prompts and retains them across human turns', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
  const rig = await createQueuedMessageTestRig()
  hostRef.current = rig.host
  installFakeAppEnvironment({ getPath: () => rig.root })
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  const base = buildProfileStateCutoverFixture('/fixture').automationRuns[0]
  const runs = ['A', 'B'].map((id, index) => ({
    ...base,
    id,
    sessionKind: 'chat' as const,
    chatSessionId: HOST_TEST_SESSION,
    status: 'dispatched' as const,
    createdAt: HOST_TEST_NOW - 2 + index,
    dispatchedAt: HOST_TEST_NOW - 2 + index
  }))
  vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue(runs)
  const record = vi
    .spyOn(runtime, 'recordAutomationRunReport')
    .mockImplementation(async ({ id }) => ({
      ok: true,
      run: runs.find((run) => run.id === id)!
    }))
  const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_RUN_RESULT_METHODS })
  const report = () =>
    dispatcher.dispatch({
      id: 'report',
      authToken: 'token',
      method: 'automation.reportFailure',
      params: { message: 'A failure' },
      orchestrationCompatibilityEvidence: { agentSessionId: HOST_TEST_SESSION }
    })
  const send = (index: number) => {
    const run = runs[index]
    return rig.host.send(
      { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
      structuredAgentSessionMessageSendMutation({
        sessionId: HOST_TEST_SESSION,
        clientOperationId: automationRunOperationId(run, 'reuse-send'),
        expectedRuntimeFence: rig.store.getConversation(HOST_TEST_SESSION)!.currentFence,
        delivery: 'queue-if-active',
        body: structuredAgentSessionSendBody(`Run ${run.id}`, [])
      })
    )
  }
  try {
    expect(await report()).toMatchObject({
      ok: false,
      error: { message: NOT_IN_AUTOMATION_RUN_MESSAGE }
    })
    expect(await send(0)).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    const aMessage = automationRunOperationId(runs[0], 'reuse-send')
    await eventually(async () =>
      expect((await rig.submission(aMessage))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(aMessage, 'A')
    const sink = rig.providerEvents()
    const aTurn = {
      provider: 'codex' as const,
      threadId: HOST_TEST_THREAD,
      turnId: 'turn-A',
      ordinal: 1
    }
    sink.appendItem(
      aTurn,
      {
        kind: 'turn',
        turnId: 'turn-A',
        userItemId: (await rig.submission(aMessage))!.providerItemId!,
        state: 'running'
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
    sink.publish({ lifecycle: true })
    await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(await send(1)).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    const bMessage = automationRunOperationId(runs[1], 'reuse-send')
    expect(await rig.handoff(bMessage)).toBeUndefined()
    expect(await report()).toMatchObject({ ok: true, result: { runId: 'A' } })
    expect(record.mock.lastCall?.[0].id).toBe('A')

    sink.appendItem(
      aTurn,
      { kind: 'turn', turnId: 'turn-A', state: 'completed', outcome: 'success' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
    sink.publish({ lifecycle: true })
    await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
    await eventually(async () => expect(await rig.handoff(bMessage)).toBeDefined())
    const bSubmission = await rig.handoffId(bMessage)
    expect(bSubmission).not.toBe(bMessage)
    await eventually(async () =>
      expect((await rig.submission(bSubmission))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(bSubmission, 'B')
    expect(await report()).toMatchObject({ ok: true, result: { runId: 'B' } })
    expect(record.mock.lastCall?.[0].id).toBe('B')

    const human = rig.send('Follow up on that result')
    expect(await human.result).toMatchObject({ ok: true })
    await rig.settleAccepted(human.id, 'human')
    expect(await report()).toMatchObject({ ok: true, result: { runId: 'B' } })
    vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue(
      runs.map((run) => ({ ...run, status: 'completed', finishedAt: HOST_TEST_NOW }))
    )
    vi.mocked(Date.now).mockReturnValue(HOST_TEST_NOW + AUTOMATION_RUN_REPORT_GRACE_MS)
    expect(await report()).toMatchObject({ ok: true, result: { runId: 'B' } })
    vi.mocked(Date.now).mockReturnValue(HOST_TEST_NOW + AUTOMATION_RUN_REPORT_GRACE_MS + 1)
    expect(await report()).toMatchObject({
      ok: false,
      error: { message: NOT_IN_AUTOMATION_RUN_MESSAGE }
    })
  } finally {
    await rig.dispose()
  }
})
