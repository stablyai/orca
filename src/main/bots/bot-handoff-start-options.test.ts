import { expect, test, vi } from 'vitest'
import { startBotSession } from './bot-chat-session'
import { makeTestBot } from './bot.test-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session/agent-session-wire'
import type * as StructuredSessionRegistry from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

const { records, prepareSaved } = vi.hoisted(() => ({
  records: new Map<string, Readonly<Record<string, string>> | undefined>(),
  prepareSaved: vi.fn<() => Promise<AgentSessionModelCatalogResult>>()
}))

vi.mock('../runtime/rpc/methods/structured-agent-session-create-background', () => ({
  createBackgroundStructuredAgentSession: async ({
    envelope,
    options
  }: {
    envelope: { sessionId: string }
    options?: Readonly<Record<string, string>>
  }) => {
    records.set(envelope.sessionId, options)
    return { ok: true }
  }
}))

vi.mock(
  '../native-chat/agent-session-wire/host/structured-agent-session-registry',
  async (actual) => ({
    ...(await actual<typeof StructuredSessionRegistry>()),
    getStructuredAgentSessionHost: () => ({ deps: { modelCatalog: { prepareSaved } } })
  })
)

const listed = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: true,
  models: [
    {
      id: 'gpt-5.5',
      label: 'Model A',
      isDefault: true,
      efforts: [{ value: 'low', label: 'Low' }],
      serviceTiers: [{ value: 'priority', label: 'Priority' }]
    },
    {
      id: 'example-alias',
      label: 'Alias A',
      resolvedModel: 'gpt-5.5',
      isDefault: false,
      efforts: []
    },
    {
      id: 'gpt-5.2-codex',
      label: 'Model B',
      isDefault: false,
      efforts: [{ value: 'low', label: 'Low' }],
      serviceTiers: [{ value: 'priority', label: 'Priority' }]
    }
  ]
} satisfies AgentSessionModelCatalogResult

test('a handoff keeps saved Priority for the same model and clears it across models', async () => {
  const runtime = new OrcaRuntimeService(null)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  prepareSaved.mockResolvedValue(listed)
  const bot = makeTestBot({
    launch: { model: 'gpt-5.5', options: { effort: 'low', serviceTier: 'priority' } }
  })
  const start = async (model: string, effort?: string) => {
    const id = await startBotSession(runtime, bot, {
      background: true,
      launchOptions: { model, ...(effort ? { effort } : {}) }
    })
    return records.get(id)
  }
  expect(await start('gpt-5.5', 'high')).toMatchObject({ effort: 'high', serviceTier: 'priority' })
  expect(await start('example-alias', 'high')).toMatchObject({
    model: 'example-alias',
    effort: 'high',
    serviceTier: 'priority'
  })
  const switched = await start('gpt-5.2-codex')
  expect(switched).toMatchObject({ model: 'gpt-5.2-codex', effort: 'low' })
  expect(switched?.serviceTier).toBeUndefined()
})
