import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { readNativeSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'
import { replaceAgentSessionRecordOptions } from '../runtime/agent-session-record-options'
import { agentSessionStoreDraftRowWrites } from '../runtime/agent-session-store-draft'
import type { AgentSessionStoreState } from '../runtime/agent-session-store-state'
import { AcpStructuredOptions } from './acp-structured-options'
import {
  NewSessionResponseSchema,
  type SessionConfigOption
} from './generated/acp-protocol.generated'

// OMP 17.3.8 on Windows; only the captured conversation id is replaced.
const response = NewSessionResponseSchema.parse(
  JSON.parse(
    readFileSync(new URL('./fixtures/omp-v17-windows-new-no-model.json', import.meta.url), 'utf8')
  )
)
const modelOption: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'reported-model',
  options: [{ value: 'reported-model', name: 'Reported Model' }]
}

async function writtenOptions(provider: string, reader: AcpStructuredOptions) {
  const fixture = agentSessionRecordFixture()
  const record = {
    ...fixture,
    provider,
    launchDirectory: 'C:/work/chat-folder',
    providerHandleChain: fixture.providerHandleChain.map((link) => ({
      ...link,
      handle: { transport: 'acp', agent: provider, nativeId: response.sessionId }
    }))
  }
  const published: AgentSessionStoreState = {
    records: new Map([[record.sessionId, record]]),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
  const options = await readNativeSessionOptions({
    adapter: { readOptions: async () => reader.read() },
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence
  })
  if (!options) {
    throw new Error('The live reader must report its options')
  }
  const changed = replaceAgentSessionRecordOptions(record, {
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence,
    options,
    now: 3_000
  })
  const writes = agentSessionStoreDraftRowWrites(published, {
    ...published,
    records: new Map([[record.sessionId, changed]])
  })
  expect(writes?.records.upsert).toHaveLength(1)
  const stored = JSON.parse(writes?.records.upsert[0]?.[1] ?? 'null')
  expect(isPersistedAgentSessionRecord(stored)).toBe(true)
  expect(stored.options).toEqual(options)
  return options
}

describe('ACP sessions without a reported model', () => {
  it('writes the captured Windows OMP startup through the live reader and shared normalizer', async () => {
    const reader = new AcpStructuredOptions()
    reader.adoptSession(response)
    expect(reader.read()).toEqual({
      models: [],
      current: { effort: 'off', confirmed: ['effort'] }
    })
    expect(reader.reported()).toEqual({ effort: 'off' })
    expect(await writtenOptions('omp', reader)).toEqual({ effort: 'off' })
  })

  it.each(['grok', 'opencode'])('writes missing-model options for %s', async (provider) => {
    const reader = new AcpStructuredOptions()
    reader.adoptSession({})
    expect(reader.read().current).not.toHaveProperty('model')
    expect(await writtenOptions(provider, reader)).toEqual({})
  })

  it.each(['config', 'legacy'] as const)('does not expose an empty %s model value', (source) => {
    const reader = new AcpStructuredOptions()
    reader.adoptSession(
      source === 'config'
        ? { configOptions: [{ ...modelOption, currentValue: '', options: [] }] }
        : { models: { currentModelId: '', availableModels: [] } }
    )
    expect(reader.read().current).not.toHaveProperty('model')
    expect(reader.reported()).toEqual({})
  })

  it('records a model reported after a startup with no model', async () => {
    const reader = new AcpStructuredOptions()
    reader.adoptSession(response)
    expect(await writtenOptions('omp', reader)).toEqual({ effort: 'off' })
    reader.adoptConfigOptions([...(response.configOptions ?? []), modelOption])
    expect(reader.read().current).toEqual({
      model: 'reported-model',
      effort: 'off',
      confirmed: ['model', 'effort']
    })
    expect(await writtenOptions('omp', reader)).toEqual({ model: 'reported-model', effort: 'off' })
  })
})
