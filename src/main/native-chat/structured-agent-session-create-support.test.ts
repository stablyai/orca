import { describe, expect, it } from 'vitest'
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
})
