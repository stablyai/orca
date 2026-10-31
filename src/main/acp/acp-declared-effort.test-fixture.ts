import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AcpDeclaredEffortFixtureModule,
  DeclaredEffortCase
} from '../../shared/acp-declared-effort.test-fixture-contract'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session-wire'
import recordedGrok from './fixtures/grok-v1-model.json'
import { AcpStructuredOptions, readAcpLiveOptions } from './acp-structured-options'
import { grokModelCatalogFromState, grokModelEfforts } from './acp-dialects/grok-model-catalog'
import { parseOpenCodeModelListing } from '../opencode/opencode-model-catalog-listing'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import {
  agentModelCatalogEntry,
  agentModelCatalogEntryWithSuccess,
  agentModelCatalogResultFromEntry,
  entryWithConfiguredDefault
} from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import { openStructuredAgentSessionConversationJournal } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../runtime/agent-session-record-store-test-harness'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'

const unused = (): never => {
  throw new Error('declaration fixture must not start or mutate an agent')
}

export function recordedEffortSource(input: DeclaredEffortCase) {
  const agent = input === 'opencode' ? 'opencode' : 'grok'
  const raw = {
    ...recordedGrok,
    _meta: { ...recordedGrok._meta, reasoningEffort: input === 'low' ? 'low' : 'max' }
  }
  const models =
    agent === 'grok'
      ? grokModelCatalogFromState({ currentModelId: raw.modelId, availableModels: [raw] })
      : parseOpenCodeModelListing(
          readFileSync(join(import.meta.dirname, 'fixtures/opencode-v1-model-listing.txt'), 'utf8')
        )
  const model = models[0]!.id
  const state = {
    models: {
      currentModelId: model,
      availableModels: agent === 'grok' ? [raw] : [{ modelId: model, name: model }]
    }
  }
  const options = new AcpStructuredOptions({ modelEfforts: grokModelEfforts })
  options.adoptSession(
    {
      ...state,
      ...(input === 'max'
        ? {
            configOptions: [
              {
                id: 'effort',
                name: 'Effort',
                type: 'select' as const,
                category: 'thought_level' as const,
                currentValue: 'max',
                options: models[0]!.efforts.map((e) => ({ value: e.value, name: e.label }))
              }
            ]
          }
        : {})
    },
    'new'
  )
  const listing = options.startListing()
  const live = agentModelCatalogEntry(
    agent,
    'fp',
    null,
    { ...listing, origin: 'live-session', at: 1 },
    null
  )!
  const configured = entryWithConfiguredDefault(live, listing.configuredDefault!, 1)!
  const entry = agentModelCatalogEntryWithSuccess(
    configured,
    { agent, fingerprint: 'fp' },
    { models, origin: 'probe' },
    'discovery',
    2
  )!
  const catalog = agentModelCatalogResultFromEntry(entry, true, false)
  const modelOnly = new AcpStructuredOptions({ modelEfforts: grokModelEfforts })
  modelOnly.adoptSession(state, 'new')
  // Old peers omit only the additive observation, leaving policy and accepted inputs intact.
  if (input === 'absent') {
    const dialect = {
      modelEfforts: (info: Parameters<typeof grokModelEfforts>[0]) => {
        const { declaredDefaultEffort: _observation, ...old } = grokModelEfforts(info)
        return old
      }
    }
    const oldOptions = new AcpStructuredOptions(dialect)
    oldOptions.adoptSession(state, 'new')
    return {
      agent,
      model,
      options,
      modelOnly: oldOptions,
      listing,
      catalog: {
        ...catalog,
        models: catalog.models.map(({ declaredDefaultEffort: _observation, ...row }) => row)
      }
    }
  }
  return { agent, model, options, modelOnly, listing, catalog }
}

export function declaredEffortAgents(agent: string, adapter: StructuredAgentSessionAdapter) {
  return new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(acpLaunchSpecFor(agent)!), adapter }
  ])
}

export function declaredEffortReadAdapter(options: AcpStructuredOptions) {
  return {
    acquire: unused,
    open: unused,
    dispatch: unused,
    cancelTurn: unused,
    answerPrompt: unused,
    setOption: unused,
    compact: unused,
    changeThreadGoal: unused,
    rewind: unused,
    recoverRewind: unused,
    readOptions: () =>
      readAcpLiveOptions({
        connection: { initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }) },
        options
      })
  } satisfies StructuredAgentSessionAdapter
}

export async function readRecordedAcpOptions(
  options: AcpStructuredOptions,
  agent: string,
  catalog: AgentSessionModelCatalogResult,
  saved: Record<string, string>
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-36455-declaration-'))
  const record = agentSessionRecordFixture({
    sessionId: 'recorded-live-options',
    provider: agent,
    options: saved
  })
  const logger = recordingStructuredAgentSessionLogger().logger
  const adapter = declaredEffortReadAdapter(options)
  try {
    await seedTestAgentSessionRecordStore(root, { records: [record] })
    const store = await openTestAgentSessionRecordStore(root)
    const deps: StructuredAgentSessionHostDeps = {
      store,
      adapter,
      agents: declaredEffortAgents(agent, adapter),
      logger,
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'test-key',
      modelCatalog: {
        read: async () => catalog,
        snapshot: () => catalog,
        prepareSaved: async () => catalog,
        demand: async () => {},
        captureSource: () => () => true,
        retireContext: () => {},
        peek: () => null,
        recordLiveListing: () => {},
        prewarm: async () => {},
        stop: () => {},
        providerStarted: () => {}
      }
    }
    const conversation = store.getConversation(record.sessionId)
    if (!conversation) {
      throw new Error('fixture record missing')
    }
    const { session } = await openStructuredAgentSessionConversationJournal(deps, conversation)
    try {
      session.child = { generation: 'test-generation', fence: 1, phase: 'ready' }
      const context = {
        deps,
        serialize: <T>(_id: string, task: () => Promise<T>) => task(),
        openConversation: async () => session,
        conversation: async () => session
      }
      const live = await readStructuredAgentSessionOptions(context, record.sessionId, {
        readsWithoutModel: true
      })
      session.child = null
      const resting = await readStructuredAgentSessionOptions(context, record.sessionId, {
        readsWithoutModel: true
      })
      return { live, resting }
    } finally {
      await session.journal.close()
    }
  } finally {
    await closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
}

export const recordedEffortCase: AcpDeclaredEffortFixtureModule['recordedEffortCase'] = async (
  input
) => {
  const source = recordedEffortSource(input)
  const { live, resting } = await readRecordedAcpOptions(
    source.modelOnly,
    source.agent,
    source.catalog,
    { model: source.model }
  )
  const { resting: launch } = await readRecordedAcpOptions(
    source.options,
    source.agent,
    source.catalog,
    {}
  )
  return {
    agent: source.agent,
    model: source.model,
    policy: source.agent === 'grok' ? 'high' : 'low',
    display: input === 'low' ? 'low' : input === 'absent' ? undefined : null,
    catalog: source.catalog,
    live,
    resting,
    launch
  }
}
