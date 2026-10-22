import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function publishRunningTurn(first: string): Promise<void> {
  rig.providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 99 },
    {
      kind: 'turn',
      turnId: 'turn-a',
      state: 'running',
      userItemId: agentJournalSubmissionKey(first)
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(SESSION)
}

it.each([
  { label: 'pause', change: { kind: 'status', status: 'paused' } },
  { label: 'edit', change: { kind: 'set', objective: 'Updated objective' } },
  { label: 'clear', change: { kind: 'clear' } }
] as const)(
  'runs a goal $label while Codex holds an earlier send for different choices',
  async ({ change }) => {
    const changeGoal = vi.fn(async () => ({ ok: true as const }))
    rig.host.deps.adapter.changeThreadGoal = changeGoal
    const fields = { key: 'model', value: 'model-a' }
    expect(
      await rig.host.setOption(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    const first = await rig.workingSend()
    await rig.settleAccepted(first, 'a')
    await publishRunningTurn(first)
    expect(
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.newestTurn()
    ).toMatchObject({ state: 'running', userItemId: agentJournalSubmissionKey(first) })
    const held = rig.send('Use a different model', undefined, {
      carried: { model: 'model-b' }
    })
    expect(await held.result).toMatchObject({ ok: true })
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    expect(rig.dispatch).toHaveBeenCalledOnce()
    const goal = rig.host.changeThreadGoal(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ change }, 'agentSession.threadGoal', hostTestOperationId()),
      change
    })
    await eventually(() => expect(changeGoal).toHaveBeenCalledOnce())
    expect(await goal).toMatchObject({ ok: true })
    expect(changeGoal).toHaveBeenCalledWith(expect.objectContaining({ change }))
    expect(rig.dispatch).toHaveBeenCalledOnce()
    expect(await rig.submission(held.id)).toMatchObject({ dispatchState: 'pending' })
    expect((await rig.submission(held.id))?.handedOverAt).toBeUndefined()
  }
)

it('releases a startup goal when a second message parks while the first turn opens', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  const changeGoal = vi.fn(async () => ({ ok: true as const }))
  rig.host.deps.adapter.changeThreadGoal = changeGoal
  const first = rig.send('First model', undefined, { carried: { model: 'model-a' } })
  const second = rig.send('Second model', undefined, { carried: { model: 'model-b' } })
  await first.result
  await second.result
  const change = { kind: 'set' as const, objective: 'A startup objective' }
  const goal = rig.host.changeThreadGoal(QUEUED_RIG_CALLER, {
    envelope: rig.envelope({ change }, 'agentSession.threadGoal', hostTestOperationId()),
    change
  })
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
  await rig.proveStart()
  await eventually(() => expect(changeGoal).toHaveBeenCalledOnce())
  expect(await goal).toMatchObject({ ok: true })
  expect(rig.dispatch).toHaveBeenCalledOnce()
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
})
