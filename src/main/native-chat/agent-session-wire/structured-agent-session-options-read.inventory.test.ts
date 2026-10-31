import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AcpStructuredOptions } from '../../acp/acp-structured-options'
import { NewSessionResponseSchema } from '../../acp/generated/acp-protocol.generated'
import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../shared/structured-agent-session-options'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  hostTestOptionsReadStore,
  hostTestRestingOptionsJournal,
  hostTestRestingOptionsRecord
} from './structured-agent-session-host-test-data'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

it('marks unknown resting inventory but preserves completed empty live and resting answers', async () => {
  const record = { ...hostTestRestingOptionsRecord(), provider: 'omp', options: {} }
  let inventory: AgentSessionModelCatalogResult = { origin: 'unknown' }
  let live: StructuredAgentSessionLiveOptions | undefined
  const session = () => ({
    child: live ? { fence: 1 } : null,
    params: { provider: record.provider },
    journal: hostTestRestingOptionsJournal()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
  const context = {
    deps: {
      adapter: { readOptions: async () => live },
      agents: NO_STRUCTURED_AGENTS,
      store: hostTestOptionsReadStore(() => record),
      modelCatalog: { read: async () => inventory }
    },
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => session(),
    conversation: async () => session()
  } as unknown as StructuredAgentSessionMutationContext
  const read = () =>
    readStructuredAgentSessionOptions(context, record.sessionId, { readsWithoutModel: true })
  const unknown = await read()
  expect(unknown).toMatchObject({ models: [], modelsKnown: false, current: { defaulted: [] } })
  expect(unknown.current.model).toBeUndefined()
  inventory = { origin: 'probe', models: [], fetchedAt: 1 }
  const empty = await read()
  expect(empty.models).toEqual([])
  expect(empty).not.toHaveProperty('modelsKnown')
  inventory = { origin: 'unknown' }
  // Captured OMP 17.3.8 Windows setup; the saved literal below is independent synthetic context.
  const acp = new AcpStructuredOptions()
  acp.adoptSession(
    NewSessionResponseSchema.parse(
      JSON.parse(
        readFileSync(
          new URL('../../acp/fixtures/omp-v17-windows-new-no-model.json', import.meta.url),
          'utf8'
        )
      )
    )
  )
  live = acp.read()
  expect(live).toEqual({ models: [], current: { effort: 'off', confirmed: ['effort'] } })
  const model = 'openai/gpt-future[1m]'
  record.options = { model }
  const completed = await read()
  expect(completed.models).toEqual([])
  expect(completed).not.toHaveProperty('modelsKnown')
  expect(completed.current).toMatchObject({ model, effort: 'off', confirmed: ['effort'] })
  const seed = structuredAgentSessionSeedCatalog('omp')
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('omp', seed),
    seed,
    completed
  )
  expect(structuredAgentSessionOptionSnapshot(state)).toMatchObject([
    { id: 'model', kind: { currentValue: model } },
    { id: 'effort', kind: { currentValue: 'off' } }
  ])
  const native = {
    id: 'openai/gpt-5.5',
    label: 'Provider authored label',
    isDefault: true,
    efforts: []
  }
  inventory = { origin: 'probe', fetchedAt: 1, models: [native] }
  expect(
    applyStructuredAgentSessionModelCatalog(state, seed, inventory, { newLaunch: false }).catalog
  ).toBe(state.catalog)
  // Constructed unfinished observation tests passthrough; ACP did not report this marker.
  live = { ...acp.read(), modelsKnown: false }
  expect((await read()).modelsKnown).toBe(false)

  live = undefined
  const result = await read()
  expect(result.current.model).toBe(model)
  expect(result.models[0]).toBe(native)
  const resting = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('omp', seed),
    seed,
    result
  )
  expect(structuredAgentSessionOptionSnapshot(resting)[0].kind).toMatchObject({
    currentValue: model,
    choices: [
      { value: native.id, label: native.label },
      { value: model, label: 'Openai GPT Future (1M context)', description: model }
    ]
  })
})
