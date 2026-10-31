import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { CodexAppServerConnection } from '../../codex/app-server/codex-app-server-connection-types'
import {
  readCodexAppliedInputOptions,
  resolvedCodexMessageOptions
} from '../../codex/codex-structured-message-options'
import { optionSession } from '../../codex/codex-structured-option-session.test-fixture'
import { dispatchCodexTurn } from '../../codex/codex-structured-turn-start'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
let native: ReturnType<typeof optionSession>
const nativeRequest = vi.fn<CodexAppServerConnection['request']>()

async function createGoalRig(reports = true): Promise<QueuedMessageTestRig> {
  nativeRequest
    .mockReset()
    .mockImplementation(async (method, params) =>
      method === 'turn/steer' ? { turnId: params?.expectedTurnId } : {}
    )
  native = optionSession(nativeRequest)
  native.threadId = THREAD
  const opened: Record<string, string> = reports ? { model: 'gpt-ran', effort: 'high' } : {}
  native.reportedOptions = opened
  native.appliedTurnOptions = opened
  const created = await createQueuedMessageTestRig({
    restartable: true,
    ...(reports ? { reportsModel: 'gpt-ran', reportsEffort: 'high' } : {})
  })
  created.host.deps.adapter.readAppliedInputOptions = (input) =>
    input.sessionId === SESSION ? readCodexAppliedInputOptions(native, input) : null
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
async function startGoalTurn(
  firstChoices?: Readonly<Record<string, string>>,
  beforeGoal?: () => Promise<void>
): Promise<void> {
  const first = await rig.workingSend(firstChoices)
  await rig.settleAccepted(first, 'first')
  await beforeGoal?.()
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

it.each<{ label: string; choices: Readonly<Record<string, string>> }>([
  { label: 'matching', choices: { model: 'gpt-ran', effort: 'high' } },
  { label: 'inherited', choices: {} },
  { label: 'partly inherited', choices: { model: 'other-model' } }
])('explicitly steers a goal turn with its $label accepted choices', async ({ choices }) => {
  const hasChoices = Object.keys(choices).length > 0
  await (hasChoices
    ? startGoalTurn({ model: 'earlier-model' }, async () => {
        const latest = await rig.workingSend(choices)
        await rig.settleAccepted(latest, 'latest')
      })
    : startGoalTurn(choices))
  const fields = {
    body: hostTestMessage('Steer the goal turn'),
    steer: true as const,
    options: { model: 'future-model', effort: 'low' }
  }
  const operation = hostTestOperationId()
  expect(
    await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.send', operation),
      ...fields,
      userSend: true
    })
  ).toMatchObject({ ok: true })
  const dispatches = hasChoices ? 3 : 2
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(dispatches))
  const acceptedChoices = hasChoices ? { ...choices, effort: 'high' } : choices
  expect((await rig.submission(operation))?.options).toEqual(acceptedChoices)
  expect(rig.dispatch.mock.calls[dispatches - 1]?.[0].executionOptions).toEqual(acceptedChoices)
  expect(rig.host.currentWork(SESSION)?.activeTurnId()).toBe('goal-turn')
  expect(rig.cancelTurn).not.toHaveBeenCalled()
})

it.each<{ label: string; choices: Readonly<Record<string, string>> }>([
  { label: 'matching', choices: { model: 'gpt-ran', effort: 'high' } },
  { label: 'inherited', choices: {} },
  { label: 'partly inherited', choices: { model: 'gpt-ran' } }
])('delivers $label choices while the goal turn is still running', async ({ choices }) => {
  await startGoalTurn()
  const steering = rig.send('Include the idle machine too', undefined, { carried: choices })
  expect(await steering.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect((await rig.submission(steering.id))?.handedOverAt).toBeDefined()
  expect(rig.host.currentWork(SESSION)?.working()).toBe(true)
  expect(
    rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.newestTurn()
  ).toMatchObject({ turnId: 'goal-turn', state: 'running' })
  expect(rig.cancelTurn).not.toHaveBeenCalled()
  expect(nativeRequest).toHaveBeenLastCalledWith(
    'turn/steer',
    expect.objectContaining({ expectedTurnId: 'goal-turn' }),
    expect.anything()
  )
})

it.each([
  { label: 'model', choices: { model: 'other-model', effort: 'high' } },
  { label: 'effort', choices: { model: 'gpt-ran', effort: 'low' } }
])('holds a different $label until the goal turn ends', async ({ choices }) => {
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

it('steers inherited choices without inventing an unreported model', async () => {
  await rig.dispose()
  rig = await createGoalRig(false)
  await startGoalTurn()
  const steering = rig.send('Keep going with the current choices')
  expect(await steering.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({})
  expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
})

it('does not assume an explicit choice matches when the child has not reported it', async () => {
  await rig.dispose()
  rig = await createGoalRig(false)
  await startGoalTurn()
  const steering = rig.send('Use a specific model', undefined, {
    carried: { model: 'gpt-ran' }
  })
  expect(await steering.result).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect((await rig.submission(steering.id))?.handedOverAt).toBeUndefined()
})

it.each([
  { label: 'steers the overriding choices', choices: { model: 'other-model' }, dispatches: 2 },
  { label: 'holds the reported model', choices: { model: 'gpt-ran' }, dispatches: 1 }
])(
  'compares with the last turn/start override the goal inherits: $label',
  async ({ choices, dispatches }) => {
    await startGoalTurn({ model: 'other-model', effort: 'high' })
    const steering = rig.send('Follow up', undefined, { carried: { ...choices, effort: 'high' } })
    expect(await steering.result).toMatchObject({ ok: true })
    await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
    expect(rig.dispatch).toHaveBeenCalledTimes(dispatches)
  }
)

it('compares with a send that set the thread choices before its turn rejected it', async () => {
  await startGoalTurn(undefined, async () => {
    const stopped = await rig.workingSend({ model: 'other-model', effort: 'high' })
    await rig.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: stopped,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      answeredInTurn: {
        turn: { provider: 'codex', threadId: THREAD, turnId: 'turn-stopped', ordinal: 0 },
        via: 'start'
      }
    })
  })
  const steering = rig.send('Back to the reported model', undefined, {
    carried: { model: 'gpt-ran', effort: 'high' }
  })
  expect(await steering.result).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  expect(rig.dispatch).toHaveBeenCalledTimes(2)
})
