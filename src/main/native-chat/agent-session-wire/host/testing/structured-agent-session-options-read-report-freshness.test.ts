import { expect, it } from 'vitest'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'

it('exports the saved selection without response or confirmed-init picker overrides', async () => {
  const rig = await createQueuedMessageTestRig({ agent: 'claude' })
  try {
    const fields = { key: 'model', value: 'opus[1m]' }
    expect(
      await rig.host.setOption(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    for (const current of [
      { model: 'claude-opus-5-5', confirmed: ['model'] },
      { model: 'claude-opus-5-5', reportedModel: 'claude-opus-4-8' }
    ]) {
      rig.host.deps.adapter.readOptions = async () => ({ models: [], current })
      const answer = await rig.host.readOptions(SESSION)
      expect(answer.current.model).toBe('opus[1m]')
      expect(answer.current.reportedModel).toBeUndefined()
    }
  } finally {
    await rig.dispose()
  }
})

it.each([
  ['new pick', QUEUED_RIG_CALLER, ['sonnet'], 'sonnet'],
  ['pick back', QUEUED_RIG_CALLER, ['sonnet', 'opus[1m]'], 'opus[1m]'],
  [
    'legacy empty no-op',
    { ...QUEUED_RIG_CALLER, readsOptionsWithoutModel: false },
    [''],
    'opus[1m]'
  ]
] as const)(
  'projects the latest saved choice through a %s while recovery choices load',
  async (_, caller, models, expectedModel) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    try {
      const pick = async (value: string) => {
        const fields = { key: 'model', value }
        return rig.host.setOption(caller, {
          envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
          ...fields
        })
      }
      expect(await pick('opus[1m]')).toMatchObject({ ok: true })
      rig.host.deps.adapter.readOptions = async () => ({
        models: [],
        current: { model: 'claude-opus-5-5', reportedModel: 'claude-opus-4-8' }
      })
      const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      await appendUsageLimitedTurn(journal, NOW, 'quota')
      const recovering = Promise.withResolvers<void>()
      const released = Promise.withResolvers<undefined>()
      rig.host.deps.resolveLaunchEnv = () => {
        recovering.resolve()
        return released.promise
      }
      const answer = rig.host.readOptions(SESSION)
      await recovering.promise
      for (const model of models) {
        expect(await pick(model)).toMatchObject({ ok: true })
      }
      released.resolve(undefined)
      const { current } = await answer
      expect(current.model).toBe(expectedModel)
      expect(current.reportedModel).toBeUndefined()
    } finally {
      await rig.dispose()
    }
  }
)
