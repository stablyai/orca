import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProfileRouter } from '../../claude-accounts/claude-profile-router'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'

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
