import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { CodexAppServerConnection } from '../../../../codex/app-server/codex-app-server-connection-types'
import {
  readCodexAppliedInputOptions,
  resolvedCodexMessageOptions
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
} from './structured-agent-session-host-test-data'

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

it('keeps a Steered card that changes the speed tier queued until the running turn ends', async () => {
  const first = await rig.workingSend()
  await rig.settleAccepted(first, 'first')
  native.activeTurnIds = new Set(['turn-first'])
  const turn = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-first', ordinal: 99 }
  const scope = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  rig.providerEvents().appendItem(
    turn,
    {
      kind: 'turn',
      turnId: 'turn-first',
      state: 'running',
      userItemId: `codex:${THREAD}:turn-first:0`
    },
    scope
  )
  await rig.host.flushStreamedEvents(SESSION)
  const priority = { model: 'gpt-ran', effort: 'high', serviceTier: 'priority' }
  const card = rig.send('Answer on the priority tier', undefined, { carried: priority })
  expect(await card.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })

  expect(await rig.sendNow(card.id)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
  })
  expect(await rig.drafts()).toEqual([{ messageId: card.id, state: 'waiting' }])
  expect(await rig.handoff(card.id)).toBeUndefined()

  native.activeTurnIds = new Set()
  rig
    .providerEvents()
    .appendItem(turn, { kind: 'turn', turnId: 'turn-first', state: 'completed' }, scope)
  await rig.host.flushStreamedEvents(SESSION)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(priority)
})

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
