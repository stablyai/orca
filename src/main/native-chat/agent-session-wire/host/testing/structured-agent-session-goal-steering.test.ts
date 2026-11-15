import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { CodexAppServerConnection } from '../../../../codex/app-server/codex-app-server-connection-types'
import {
  resolvedCodexMessageOptions,
  readCodexMessageSteeringInputs
} from '../../../../codex/structured/turns/codex-structured-message-options'
import { optionSession } from '../../../../codex/structured/catalog/codex-structured-option-session.test-fixture'
import { dispatchCodexTurn } from '../../../../codex/structured/turns/codex-structured-turn-start'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig
let native: ReturnType<typeof optionSession>
const nativeRequest = vi.fn<CodexAppServerConnection['request']>()

async function createGoalRig(): Promise<QueuedMessageTestRig> {
  nativeRequest
    .mockReset()
    .mockImplementation(async (method, params) =>
      method === 'turn/steer' ? { turnId: params?.expectedTurnId } : {}
    )
  native = optionSession(nativeRequest)
  native.threadId = THREAD
  const opened: Record<string, string> = { model: 'gpt-ran', effort: 'high' }
  native.reportedOptions = opened
  native.appliedTurnOptions = opened
  const created = await createQueuedMessageTestRig({
    restartable: true,
    reportsModel: 'gpt-ran',
    reportsEffort: 'high'
  })
  created.host.deps.adapter.captureMessageSteeringInputs = (input) =>
    input.sessionId === SESSION
      ? readCodexMessageSteeringInputs(native, input)
      : { kind: 'codex-unavailable' }
  created.host.deps.adapter.holdsLiveProviderProcess = (sessionId, generation) =>
    sessionId === SESSION &&
    generation === native.acquisitionGeneration &&
    !native.ended &&
    !native.connection.closed
  created.dispatch.mockImplementation(async (input) =>
    dispatchCodexTurn(
      native,
      { ...input, turnOptions: await resolvedCodexMessageOptions(native, input.executionOptions) },
      undefined
    )
  )
  return created
}

beforeEach(async () => {
  rig = await createGoalRig()
})

afterEach(() => rig.dispose())

/** Codex goal turns have no ordinary Orca submission as their opener. */
async function startGoalTurn(): Promise<void> {
  const first = await rig.workingSend()
  await rig.settleAccepted(first, 'first')
  rig.host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  const change = { kind: 'set' as const, objective: 'Keep improving the project' }
  expect(
    await rig.host.changeThreadGoal(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ change }, 'agentSession.threadGoal', hostTestOperationId()),
      change
    })
  ).toMatchObject({ ok: true })
  native.activeTurnIds = new Set(['goal-turn'])
  rig.providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'goal-turn', ordinal: 99 },
    {
      kind: 'turn',
      turnId: 'goal-turn',
      state: 'running',
      userItemId: `codex:${THREAD}:goal-turn:0`
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(SESSION)
}

it('holds a Plan choice until the goal turn ends', async () => {
  const choices = { model: 'gpt-ran', effort: 'high', interactionMode: 'plan' }
  await startGoalTurn()
  const steering = rig.send('Use different choices', undefined, { carried: choices })
  expect(await steering.result).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect((await rig.submission(steering.id))?.handedOverAt).toBeUndefined()
  native.activeTurnIds = new Set()
  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'goal-turn', ordinal: 99 },
      { kind: 'turn', turnId: 'goal-turn', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(choices)
})

it('keeps an incompatible Send-now card intact until a new turn can use its choices', async () => {
  await startGoalTurn()
  const choices = { model: 'gpt-ran', effort: 'high', serviceTier: 'priority' }
  const queued = rig.send('Keep my selected speed', 'queue-if-active', { carried: choices })
  expect(await queued.result).toMatchObject({ ok: true, value: { queued: {} } })
  const operationId = hostTestOperationId()
  for (let press = 0; press < 2; press += 1) {
    expect(await rig.sendNow(queued.id, operationId)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'turnActive' } }
    })
  }
  expect(await rig.handoff(queued.id)).toBeUndefined()
  expect(
    await rig.host
      .collaboratorsForTests()
      .sessions.get(SESSION)
      ?.journal.queuedMessages.get(queued.id)
  ).toMatchObject({
    state: 'waiting',
    body: { blocks: [{ type: 'text', text: 'Keep my selected speed' }] },
    options: choices
  })

  native.activeTurnIds = new Set()
  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'goal-turn', ordinal: 99 },
      { kind: 'turn', turnId: 'goal-turn', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)
  await eventually(async () => expect((await rig.handoff(queued.id))?.handedOverAt).toBeDefined())
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(choices)
  expect(await rig.sendNow(queued.id, operationId)).toMatchObject({
    ok: true,
    value: { submission: { queuedMessageId: queued.id } }
  })
})
