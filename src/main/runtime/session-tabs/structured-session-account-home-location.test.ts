import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProfileRouter } from '../../claude-accounts/claude-profile-router'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import { onRunningAccount } from '../../native-chat/agent-model-catalog/agent-model-catalog-running-account'
import { structuredAgentRuntimeMetadata } from '../structured-agent-runtime-metadata'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentDrivesSession } from '../../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { claudeAndCodexAgents } from '../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { AgentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'

vi.mock('./structured-session-cli-writer-host', () => ({
  OrcaRuntimeWithStructuredSessionCliWriterHost: class {}
}))
vi.mock('../../orca-profiles/profile-storage-paths', async () => {
  const { tmpdir } = await import('node:os')
  return { getProfileUserDataPath: () => tmpdir() }
})
const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it('with a router names the selected account before its folder exists, through the real runtime resolver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-account-identity-'))
  roots.push(root)
  const settings = {
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const runSetup = vi.fn(async () => {
    throw new Error('setup refused')
  })
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: root,
    userHome: join(root, 'personal'),
    env: {},
    runSetup
  })
  installClaudeProfileRouter(router)
  const runtime: OrcaRuntimeWithStructuredSessionAccountHome = Object.assign(
    Object.create(OrcaRuntimeWithStructuredSessionAccountHome.prototype),
    {
      accounts: { getClaudeConfigDirectory: () => router.systemDefaultHome() },
      requireStore: () => ({ getSettings: () => settings }),
      structuredAgentLaunchEnv: () => ({})
    }
  )
  const record = agentSessionRecordFixture()
  const selected = { variable: 'CLAUDE_CONFIG_DIR', path: router.accountHome('a') }
  await expect(
    runtime.resolveStructuredAgentLaunchAccountHome(record, 'identity')
  ).resolves.toEqual(selected)
  await expect(runtime.resolveStructuredAgentLaunchAccountHome(record)).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'claudeAccountFolderMissing'
  })
  // Neither read starts the account's setup; only a launch does.
  expect(runSetup).not.toHaveBeenCalled()
  mkdirSync(selected.path, { recursive: true })
  await expect(runtime.resolveStructuredAgentLaunchAccountHome(record)).resolves.toEqual(selected)
  await expect(
    runtime.resolveStructuredAgentLaunchAccountHome(record, 'identity')
  ).resolves.toEqual(selected)
})

it('without a router keeps the founding home through the real runtime and catalog account resolver', async () => {
  installClaudeProfileRouter(undefined)
  const getSettings = vi.fn(() => {
    throw new Error('a pinned read must not inspect local settings')
  })
  const runtime: OrcaRuntimeWithStructuredSessionAccountHome = Object.assign(
    Object.create(OrcaRuntimeWithStructuredSessionAccountHome.prototype),
    { requireStore: () => ({ getSettings }) }
  )
  const writable = agentSessionRecordFixture()
  const record = agentSessionConversationView(writable)
  const result = await onRunningAccount(
    {
      getRecord: () => writable,
      launchAccountHome: runtime.resolveStructuredAgentLaunchAccountHome.bind(runtime)
    },
    record
  )
  expect(result).toBe(record)
  expect(result.accountHome).toEqual(record.accountHome)
  expect(getSettings).not.toHaveBeenCalled()
})

it.each([
  { executionHostId: 'ssh:remote', wslDistro: null },
  { executionHostId: 'local', wslDistro: 'Ubuntu' }
] as const)(
  'unsupported $executionHostId/$wslDistro never probes or mutates the local catalog',
  async (location) => {
    const record = {
      ...agentSessionRecordFixture(),
      location: { ...agentSessionRecordFixture().location, ...location }
    }
    expect(structuredAgentRuntimeMetadata('claude')!.supportsLocation(record.location)).toBe(false)
    const probe = vi.fn()
    const store = new AgentModelCatalogStore()
    const write = vi.spyOn(store, 'recordSuccess')
    const resolveAccountHome = vi.fn(async () => record.accountHome)
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record,
      getConversation: () => agentSessionConversationView(record),
      drivesRecord: (entry) => agentDrivesSession(claudeAndCodexAgents(), entry),
      resolveAccountHome,
      probes: { claude: probe }
    })
    expect(
      await service.read({ agent: 'claude', sessionId: record.sessionId, waitForListing: true })
    ).toEqual({ origin: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(resolveAccountHome).not.toHaveBeenCalled()
    service.stop()
  }
)
