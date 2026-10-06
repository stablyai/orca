import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { ClaudeManagedAccountGateSettings } from './claude-structured-managed-account-support'
import { resolveStructuredAgentSessionCreateSupport } from './structured-agent-session-create-support'

const LOCAL: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

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

const HOST_SELECTED: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('host-1', 'host')],
  activeClaudeManagedAccountId: 'host-1',
  activeClaudeManagedAccountIdsByRuntime: { host: 'host-1', wsl: {} }
}

const WSL_ONLY: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('wsl-1', 'wsl')],
  activeClaudeManagedAccountId: null,
  activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
}

function support(
  overrides: Partial<Parameters<typeof resolveStructuredAgentSessionCreateSupport>[0]> = {}
) {
  return resolveStructuredAgentSessionCreateSupport({
    agent: 'claude',
    location: LOCAL,
    adapterSupportsCreate: true,
    getSettings: () => HOST_SELECTED,
    ...overrides
  })
}

describe('resolveStructuredAgentSessionCreateSupport', () => {
  it('supports Claude under a selected host account', () => {
    expect(support()).toEqual({ supported: true })
  })

  it('refuses Claude under a WSL-only managed account', () => {
    expect(support({ getSettings: () => WSL_ONLY })).toEqual({ supported: false, reason: 'wsl' })
  })

  it('supports an explicit profile independently of the global account lane', () => {
    expect(support({ getSettings: () => WSL_ONLY, profileBound: true })).toEqual({
      supported: true
    })
    expect(support({ getSettings: () => WSL_ONLY })).toEqual({ supported: false, reason: 'wsl' })
  })

  it.each(['claude', 'codex'] as const)(
    'refuses %s profile targets even if an adapter supports them',
    (agent) => {
      for (const location of [
        { ...LOCAL, executionHostId: 'ssh:host-a' as const },
        { ...LOCAL, wslDistro: 'Ubuntu' }
      ]) {
        expect(support({ agent, location, profileBound: true }).supported).toBe(false)
      }
      expect(support({ agent, platform: 'win32', profileBound: true })).toEqual({
        supported: false,
        reason: 'agent'
      })
      expect(support({ agent, platform: 'win32' })).toEqual({ supported: true })
    }
  )

  it('refuses profile capability inside a WSL execution host', () => {
    vi.stubEnv('WSL_INTEROP', '/run/WSL/test_interop')
    try {
      expect(support({ profileBound: true }).supported).toBe(false)
      expect(support().supported).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('fails closed for Claude when the settings throw', () => {
    expect(
      support({
        getSettings: () => {
          throw new Error('no store')
        }
      })
    ).toEqual({ supported: false, reason: 'wsl' })
  })

  it('leaves Codex to the adapter answer under the same WSL-only account', () => {
    expect(support({ agent: 'codex', getSettings: () => WSL_ONLY })).toEqual({ supported: true })
  })

  it.each([
    ['remote', { ...LOCAL, executionHostId: 'ssh:host-a' }, 'remote'],
    ['wsl workspace', { ...LOCAL, wslDistro: 'Ubuntu' }, 'wsl'],
    ['unsupported agent', LOCAL, 'agent']
  ] as const)('keeps the adapter refusal reason for %s', (_name, location, reason) => {
    expect(support({ adapterSupportsCreate: false, location })).toEqual({
      supported: false,
      reason
    })
  })

  // A custom launch command applies to terminal launches only; native chat ignores it.
  it.each([
    ['claude', 'claude-wrapper'],
    ['codex', 'codex-nightly']
  ] as const)('supports %s when this host sets launch command %s', (agent, command) => {
    const settings = { ...HOST_SELECTED, agentCmdOverrides: { [agent]: command } }
    expect(support({ agent, getSettings: () => settings })).toEqual({ supported: true })
  })
})
