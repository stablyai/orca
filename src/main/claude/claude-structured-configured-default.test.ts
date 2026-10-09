// A new Claude chat names its model and effort on the first frame: a chat launched with nothing
// picked reports the model the CLI's own config resolution applies, and the host keeps that as the
// account's configured default when the chat's workspace has no Claude settings of its own.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { getAgentSessionOptionCatalog } from '../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  claudeStartupSettled
} from './claude-structured-session-test-support'

const SESSION = 'session-1'
const ACCOUNT_HOME = '/accounts/claude'
const EFFORTS = ['low', 'medium', 'high']

const CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  }
]

/** The user's settings pick Sonnet over the listing's recommended Opus; the CLI applies Sonnet. */
async function liveListing(
  options?: Record<string, string>,
  applied: string | null = 'claude-sonnet-5'
) {
  const claude = fakeClaude({
    initProof: 'session-start',
    initModel: applied ?? 'claude-opus-5-5',
    initModels: CATALOG,
    settings: {
      effective: {},
      sources: [],
      applied: { model: applied, effort: applied ? 'high' : null, advisor: null, ultracode: false }
    },
    routes: { list_models: () => CATALOG }
  })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: options?.model ? { model: options.model } : {},
      cwd: '/work/repo',
      claudeConfigDir: ACCOUNT_HOME,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {}
  })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recordingJournalSink(),
    ...(options ? { options } : {})
  })
  await claudeStartupSettled(adapter, SESSION)
  return (await adapter.readOptions({ sessionId: SESSION, fence: 7 })).catalogListing
}

function record(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog reads only these fields.
  return {
    sessionId: SESSION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME },
    location: { executionHostId: 'local', wslDistro: null, workspaceId: 'ws-1' },
    launchDirectory: '/work/repo'
  } as unknown as AgentSessionRecord
}

function service(store: AgentModelCatalogStore, projectSettings: boolean) {
  const launched = record()
  return createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => (sessionId === SESSION ? launched : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME }),
    recordWorkspacePath: async (row) => row.launchDirectory ?? null,
    workspaceMayOverrideDefaultModel: async ({ workspacePath }) =>
      projectSettings && workspacePath === '/work/repo'
  })
}

/** What a new chat's first frame shows from the host's answer alone. */
async function firstFrame(store: AgentModelCatalogStore, workspacePath: string) {
  const answer = await service(store, false).read({ agent: 'claude', workspacePath })
  const seed = getAgentSessionOptionCatalog('claude')!
  const state = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('claude', seed),
    seed,
    answer,
    { newLaunch: true }
  )
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  const current = (id: string) => {
    const kind = snapshot.find((row) => row.id === id)?.kind
    return kind && 'currentValue' in kind ? kind.currentValue : undefined
  }
  return { answer, model: current('model'), effort: current('effort') }
}

describe('Claude configured default', () => {
  it('names the model and effort the CLI resolves for a chat with nothing picked', async () => {
    const store = new AgentModelCatalogStore()
    const listing = await liveListing()
    // Sonnet, as the user's settings pick it — not the listing's recommended Opus.
    expect(listing?.configuredDefault).toEqual({ modelId: 'sonnet', effort: 'high' })
    // The effort travels with the configured model, never as a live row's own default.
    expect(listing?.models.some((model) => model.defaultEffort !== undefined)).toBe(false)
    service(store, false).recordLiveListing(SESSION, listing!)

    await vi.waitFor(async () =>
      expect((await firstFrame(store, '/work/other')).answer).toMatchObject({
        listingNamesConfiguredModel: true
      })
    )
    const frame = await firstFrame(store, '/work/other')
    expect(frame.model).toBe('sonnet')
    expect(frame.effort).toBe('high')
  })

  it('keeps nothing from a chat whose workspace has Claude settings of its own', async () => {
    const store = new AgentModelCatalogStore()
    service(store, true).recordLiveListing(SESSION, (await liveListing())!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const frame = await firstFrame(store, '/work/other')
    expect(frame.answer).toMatchObject({ listingNamesConfiguredModel: false })
    expect(frame.model).toBeUndefined()
    // The project's effort stays out of the account's catalog too.
    const entry = store.get(agentModelCatalogFingerprintForRecord(record()))
    expect(entry?.configured).toBeNull()
    expect(entry?.models.some((model) => model.defaultEffort !== undefined)).toBe(false)
  })

  it('forgets a saved default once the config resolves to no listed model, for good', async () => {
    const store = new AgentModelCatalogStore()
    const fingerprint = agentModelCatalogFingerprintForRecord(record())
    service(store, false).recordLiveListing(SESSION, (await liveListing())!)
    await vi.waitFor(() => expect(store.get(fingerprint)?.configured?.modelId).toBe('sonnet'))

    // The user's settings now pick a model the account no longer lists.
    const unlisted = await liveListing(undefined, 'claude-retired-1')
    expect(unlisted?.configuredDefault).toBeNull()
    service(store, false).recordLiveListing(SESSION, unlisted!)
    await vi.waitFor(() => expect(store.get(fingerprint)?.configured).toBeNull())

    // A later background listing keeps it forgotten.
    store.recordSuccess(
      fingerprint,
      'claude',
      {
        models: CATALOG.map((row) => ({
          id: row.value,
          label: row.displayName,
          isDefault: row.value === 'default',
          efforts: EFFORTS.map((value) => ({ value, label: value }))
        })),
        fastModeTierByModel: new Map(),
        origin: 'probe'
      },
      'discovery'
    )
    const frame = await firstFrame(store, '/work/other')
    expect(store.get(fingerprint)?.configured).toBeNull()
    expect(frame.answer).toMatchObject({ listingNamesConfiguredModel: false })
    expect(frame.model).toBeUndefined()
  })

  it('forgets a saved default when the config resolves to no model at all', async () => {
    const listing = await liveListing(undefined, null)
    expect(listing?.configuredDefault).toBeNull()
  })

  it('learns nothing from a chat launched with a model pick', async () => {
    const listing = await liveListing({ model: 'sonnet' })
    expect(listing).toBeDefined()
    expect(listing?.configuredDefault).toBeUndefined()
  })

  it('names nothing in a workspace whose own Claude settings could pick another model', async () => {
    const store = new AgentModelCatalogStore()
    service(store, false).recordLiveListing(SESSION, (await liveListing())!)
    await vi.waitFor(() =>
      expect(store.get(agentModelCatalogFingerprintForRecord(record()))?.configured).not.toBeNull()
    )

    const answer = await createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME }),
      workspaceMayOverrideDefaultModel: async () => true
    }).read({ agent: 'claude', workspacePath: '/work/repo' })
    expect(answer).toMatchObject({ listingNamesConfiguredModel: false })
  })
})
