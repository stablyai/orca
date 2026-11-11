import { expect, it } from 'vitest'
import { hostTestCatalogReadOperation } from './structured-agent-session-host-test-data'
import '../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import '../../../agent-model-catalog/agent-model-catalog-service'
import '../../../agent-model-catalog/agent-model-catalog-store'
import { PiRpcOptionObservations, type PiRpcOptionProof } from '../../../../pi/rpc-options'
import { piOptionRefreshHost } from './structured-agent-session-option-refresh.test-fixture'

it('pairs the latest saved input with its report only after the resting read completes', async () => {
  const host = piOptionRefreshHost()
  host.record.options.effort = 'off'
  const proof: PiRpcOptionProof = {
    current: new Map([
      ['model', host.record.options.model],
      ['effort', 'off']
    ]),
    writes: new Map()
  }
  const observations = new PiRpcOptionObservations(proof, () => true)
  observations.prepare()({
    models: host.models,
    current: { model: host.record.options.model, effort: 'minimal', confirmed: ['model', 'effort'] }
  })
  host.live = observations.read()
  const entered = Promise.withResolvers<void>()
  const catalog =
    Promise.withResolvers<Awaited<ReturnType<NonNullable<typeof host.modelCatalog>['read']>>>()
  host.modelCatalog = {
    captureRead: hostTestCatalogReadOperation,
    read: () => {
      entered.resolve()
      return catalog.promise
    }
  }
  const answer = host.read()
  await entered.promise
  host.record.options.effort = 'high'
  catalog.resolve(host.home)
  const result = await answer
  expect(result.current.effort).toBe('high')
  expect(result.current.reportedEffort).toBeUndefined()
  expect(result.current.confirmed).not.toContain('effort')
  expect(result).not.toHaveProperty('projectCurrent')
  expect(result).not.toHaveProperty('effortFixed')
})
