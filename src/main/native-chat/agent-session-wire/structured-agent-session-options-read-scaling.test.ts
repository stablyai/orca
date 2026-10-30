import { describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { PiRpcOptionObservations, type PiRpcOptionProof } from '../../pi/rpc-options'
import { piOptionRefreshHost } from './structured-agent-session-option-refresh.test-fixture'

const SESSION = 'session-1'
describe('host options row work', () => {
  it('bounds resting and live host row reads without per-chat discovery at 61 and 610 models', async () => {
    const counts: number[][] = []
    for (const size of [61, 610]) {
      const host = piOptionRefreshHost()
      const record = host.record
      record.options = { model: `model-${size - 1}`, effort: 'off' }
      const models = Array.from({ length: size }, (_, index) => ({
        id: `model-${index}`,
        label: 'Model',
        isDefault: false,
        efforts: [{ value: 'minimal', label: 'Minimal' }]
      }))
      const probe = vi.fn(async () => ({ models, origin: 'probe' as const, complete: true }))
      const service = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        getRecord: () => record,
        getConversation: () => agentSessionConversationView(record),
        drivesRecord: () => true,
        resolveAccountHome: async () => record.accountHome,
        recordWorkspacePath: async () => '/workspace',
        probes: { pi: probe }
      })
      await service.read({
        agent: 'pi',
        sessionId: SESSION,
        inSessionWorkspace: true,
        waitForListing: true
      })
      let rowReads = 0
      const countRows = (rows: AgentSessionModelOption[]) =>
        rows.map(({ id, ...row }) => ({
          ...row,
          get id() {
            rowReads++
            return id
          }
        }))
      const read = service.read.bind(service)
      const reads = vi.spyOn(service, 'read').mockImplementation(async (params) => {
        const answer = await read(params)
        return answer.origin === 'unknown'
          ? answer
          : {
              ...answer,
              models: countRows(answer.models)
            }
      })
      const measured: number[] = []
      for (const live of [false, true]) {
        rowReads = 0
        host.modelCatalog = service
        host.live = live
          ? {
              models: countRows(models),
              current: { model: record.options.model, effort: 'minimal' }
            }
          : null
        const answer = await host.read()
        expect(answer.current.effort).toBe('off')
        expect(rowReads).toBeGreaterThanOrEqual(size)
        expect(rowReads).toBeLessThanOrEqual(12 * size)
        measured.push(rowReads)
      }
      counts.push(measured)
      expect(reads).toHaveBeenCalledTimes(2)
      expect(reads.mock.calls.every(([params]) => params.savedOnly === true)).toBe(true)
      expect(probe).toHaveBeenCalledTimes(1)
      service.stop()
    }
    for (const index of [0, 1]) {
      expect(counts[1]![index]).toBeLessThanOrEqual(10 * counts[0]![index]!)
    }
  })
})

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
