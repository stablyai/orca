import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { applyStructuredCodexWorkspaceTrust } from '../../agent-launch/trust/agent-workspace-trust-spawn'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProfileRouter } from '../../claude-accounts/claude-profile-router'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'

vi.mock('../../agent-launch/trust/agent-workspace-trust-spawn', () => ({
  applyStructuredCodexWorkspaceTrust: vi.fn(async () => {})
}))
vi.mock('./structured-session-cli-writer-host', () => ({
  OrcaRuntimeWithStructuredSessionCliWriterHost: class {}
}))
vi.mock('../../orca-profiles/profile-storage-paths', async () => {
  const { tmpdir } = await import('node:os')
  return { getProfileUserDataPath: () => tmpdir() }
})
const roots: string[] = []
abstract class AccountHomeRuntime extends OrcaRuntimeWithStructuredSessionAccountHome {
  resolveCreateHome(record: ReturnType<typeof agentSessionRecordFixture>) {
    return this.structuredAgentAccountHomeResolver(
      record.provider,
      '',
      'launch'
    )?.({
      launchEnv: {},
      location: record.location
    })
  }
}
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it.each([
  { kind: 'git-worktree', id: 'worktree-1', directory: '/current-workspace' },
  { kind: 'folder', id: 'folder-1', directory: '/current-workspace' },
  { kind: 'folder', id: FLOATING_TERMINAL_WORKTREE_ID, directory: '/initial-workspace' }
] as const)(
  'resolves a selected Codex account and trust for $kind/$id without read side effects',
  async ({ kind, id, directory }) => {
    let selected = '/accounts/a/home'
    const readHome = vi.fn(async () => selected)
    const prepareHome = vi.fn(async () => selected)
    const prepareAccount = vi.fn(async () => {})
    const resolveWorkspace = vi.fn(async () => ({ worktree: { path: '/current-workspace' } }))
    vi.mocked(applyStructuredCodexWorkspaceTrust).mockClear()
    const runtime: OrcaRuntimeWithStructuredSessionAccountHome = Object.assign(
      Object.create(OrcaRuntimeWithStructuredSessionAccountHome.prototype),
      {
        accounts: { getClaudeConfigDirectory: () => null, prepareHostAgentLaunch: prepareAccount },
        requireStore: () => ({ getSettings: () => ({ agentWorkspaceTrustEnabled: false }) }),
        structuredAgentLaunchEnv: () => ({}),
        resolveCodexStructuredLaunchHomeFn: readHome,
        prepareCodexStructuredLaunchFn: prepareHome,
        resolveRuntimeFileTarget: resolveWorkspace
      }
    )
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: selected },
      launchDirectory: '/initial-workspace',
      location: { ...agentSessionRecordFixture().location, workspaceId: id, workspaceKind: kind }
    }
    expect(await runtime.resolveStructuredAgentLaunchAccountHome(record, 'identity')).toEqual(
      record.accountHome
    )
    selected = '/accounts/b/home'
    expect(await runtime.resolveStructuredAgentLaunchAccountHome(record, 'identity')).toEqual({
      variable: 'CODEX_HOME',
      path: selected
    })
    expect(prepareHome).not.toHaveBeenCalled()
    expect(prepareAccount).not.toHaveBeenCalled()
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(applyStructuredCodexWorkspaceTrust).not.toHaveBeenCalled()
    expect(await runtime.resolveStructuredAgentLaunchAccountHome(record, 'launch')).toEqual({
      variable: 'CODEX_HOME',
      path: selected
    })
    expect(prepareAccount).toHaveBeenCalledWith('codex')
    expect(prepareHome).toHaveBeenCalledOnce()
    expect(applyStructuredCodexWorkspaceTrust).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: directory, codexHome: selected })
    )
    if (id === FLOATING_TERMINAL_WORKTREE_ID) {
      expect(resolveWorkspace).not.toHaveBeenCalled()
    } else {
      expect(resolveWorkspace).toHaveBeenCalledWith(`id:${id}`)
    }
  }
)

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
  const runtime: AccountHomeRuntime = Object.assign(Object.create(AccountHomeRuntime.prototype), {
    accounts: { getClaudeConfigDirectory: () => router.systemDefaultHome() },
    requireStore: () => ({ getSettings: () => settings }),
    structuredAgentLaunchEnv: () => ({})
  })
  const record = agentSessionRecordFixture()
  const selected = { variable: 'CLAUDE_CONFIG_DIR', path: router.accountHome('a') }
  await expect(
    runtime.resolveStructuredAgentLaunchAccountHome(record, 'identity')
  ).resolves.toEqual(selected)
  await expect(runtime.resolveCreateHome(record)).resolves.toEqual(selected)
  await expect(runtime.resolveStructuredAgentLaunchAccountHome(record)).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'claudeAccountFolderMissing'
  })
  // Neither read starts the account's setup; only a launch does.
  expect(existsSync(selected.path)).toBe(false)
  mkdirSync(selected.path, { recursive: true })
  await expect(runtime.resolveStructuredAgentLaunchAccountHome(record)).resolves.toEqual(selected)
  await expect(
    runtime.resolveStructuredAgentLaunchAccountHome(record, 'identity')
  ).resolves.toEqual(selected)
})
