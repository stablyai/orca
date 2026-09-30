import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function managedAccount(id: string, managedAuthRuntime: 'host' | 'wsl') {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/managed/${id}`,
    managedAuthRuntime,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const WSL_ONLY: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('wsl-1', 'wsl')],
  activeClaudeManagedAccountId: null,
  activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
}

/** Registered Claude accounts with none selected: ambient auth, and the UI names no host identity,
 *  so this must reach structured rather than silently falling back to a terminal session. */
const ACCOUNTS_PRESENT_NONE_ACTIVE: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('host-1', 'host'), managedAccount('host-2', 'host')],
  activeClaudeManagedAccountId: null,
  activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
}

const HOST_SELECTED: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('host-1', 'host')],
  activeClaudeManagedAccountId: 'host-1',
  activeClaudeManagedAccountIdsByRuntime: { host: 'host-1', wsl: {} }
}

function runtimeWithAccounts(claude: ClaudeManagedAccountGateSettings | null): OrcaRuntimeService {
  // No store at all is the unreadable-settings case the gate must fail closed on.
  const runtime = claude
    ? new OrcaRuntimeService({ getSettings: () => claude } as never)
    : new OrcaRuntimeService()
  const internal = runtime as unknown as {
    resolveStructuredAgentSessionLocation: (selector: string) => Promise<unknown>
    ensureStructuredAgentSessionHost: () => Promise<void>
  }
  internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree' as const
  }))
  // The adapter's own location answer is irrelevant here; pin it supported so only the account
  // gate can refuse.
  internal.ensureStructuredAgentSessionHost = vi.fn(async () => {})
  setStructuredAgentSessionHost({
    supportsCreate: () => true
  } as unknown as StructuredAgentSessionHost)
  return runtime
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('structured Claude managed-account gate', () => {
  it('refuses Claude under a WSL-only managed account', async () => {
    const runtime = runtimeWithAccounts(WSL_ONLY)
    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'claude')
    ).resolves.toMatchObject({ supported: false })
  })

  it('supports Claude when accounts are registered but none is selected', async () => {
    const runtime = runtimeWithAccounts(ACCOUNTS_PRESENT_NONE_ACTIVE)
    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'claude')
    ).resolves.toMatchObject({ supported: true })
  })

  it('still supports Claude under a selected host managed account', async () => {
    const runtime = runtimeWithAccounts(HOST_SELECTED)
    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'claude')
    ).resolves.toMatchObject({ supported: true })
  })

  it('fails closed for Claude when the account runtime cannot be determined', async () => {
    const runtime = runtimeWithAccounts(null)
    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'claude')
    ).resolves.toMatchObject({ supported: false })
  })

  /** The gate is Claude's alone: Codex resolves its account separately and this lane must not
   *  change any Codex answer. */
  it('leaves Codex supported under the same WSL-only Claude account', async () => {
    const runtime = runtimeWithAccounts(WSL_ONLY)
    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'codex')
    ).resolves.toMatchObject({ supported: true })
  })
})
