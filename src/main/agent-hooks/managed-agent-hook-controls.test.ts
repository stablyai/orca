import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

const hookMocks = vi.hoisted(() => {
  const status = (agent: string) => ({
    agent,
    state: 'not_installed',
    configPath: '',
    managedHooksPresent: false,
    detail: null
  })
  const makeService = (agent: string) => ({
    install: vi.fn(),
    remove: vi.fn(() => status(agent)),
    getStatus: vi.fn(() => status(agent))
  })
  return {
    status,
    getDefaultWslDistroMock: vi.fn(() => 'Ubuntu'),
    getWslHomeMock: vi.fn((distro: string): string | null =>
      distro === 'Ubuntu' ? '\\\\wsl.localhost\\Ubuntu\\home\\jin' : null
    ),
    services: {
      amp: makeService('amp'),
      antigravity: makeService('antigravity'),
      claude: makeService('claude'),
      codex: makeService('codex'),
      copilot: makeService('copilot'),
      cursor: makeService('cursor'),
      droid: makeService('droid'),
      commandCode: makeService('command-code'),
      devin: makeService('devin'),
      gemini: makeService('gemini'),
      grok: makeService('grok'),
      hermes: makeService('hermes'),
      kimi: makeService('kimi'),
      openClaude: makeService('openclaude')
    }
  }
})

vi.mock('../amp/hook-service', () => ({ ampHookService: hookMocks.services.amp }))
vi.mock('../antigravity/hook-service', () => ({
  antigravityHookService: hookMocks.services.antigravity
}))
vi.mock('../claude/hook-service', () => ({ claudeHookService: hookMocks.services.claude }))
vi.mock('../codex/hook-service', () => ({ codexHookService: hookMocks.services.codex }))
vi.mock('../copilot/hook-service', () => ({ copilotHookService: hookMocks.services.copilot }))
vi.mock('../cursor/hook-service', () => ({ cursorHookService: hookMocks.services.cursor }))
vi.mock('../droid/hook-service', () => ({ droidHookService: hookMocks.services.droid }))
vi.mock('../command-code/hook-service', () => ({
  commandCodeHookService: hookMocks.services.commandCode
}))
vi.mock('../devin/hook-service', () => ({ devinHookService: hookMocks.services.devin }))
vi.mock('../gemini/hook-service', () => ({ geminiHookService: hookMocks.services.gemini }))
vi.mock('../grok/hook-service', () => ({ grokHookService: hookMocks.services.grok }))
vi.mock('../hermes/hook-service', () => ({ hermesHookService: hookMocks.services.hermes }))
vi.mock('../kimi/hook-service', () => ({ kimiHookService: hookMocks.services.kimi }))
vi.mock('../openclaude/hook-service', () => ({
  openClaudeHookService: hookMocks.services.openClaude
}))

import {
  applyAgentStatusHooksEnabled,
  clearRecordedClaudeWslSystemDefaultHookTargetsForTests,
  removeManagedAgentHooks,
  recordClaudeWslSystemDefaultHookTarget,
  setWslSystemDefaultHookTargetResolver
} from './managed-agent-hook-controls'

function managedClaudeAccount(overrides: {
  id: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslLinuxAuthPath?: string | null
}) {
  return {
    email: `${overrides.id}@example.com`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

describe('applyAgentStatusHooksEnabled', () => {
  beforeEach(() => {
    const agentByServiceKey: Record<string, string> = {
      commandCode: 'command-code',
      openClaude: 'openclaude'
    }
    for (const [serviceKey, service] of Object.entries(hookMocks.services)) {
      const agent = agentByServiceKey[serviceKey] ?? serviceKey
      service.install.mockClear()
      service.remove.mockReset().mockImplementation(() => hookMocks.status(agent))
      service.getStatus.mockClear()
    }
    hookMocks.getDefaultWslDistroMock.mockReset().mockReturnValue('Ubuntu')
    hookMocks.getWslHomeMock
      .mockReset()
      .mockImplementation((distro: string) =>
        distro === 'Ubuntu' || distro === 'Debian'
          ? `\\\\wsl.localhost\\${distro}\\home\\jin`
          : null
      )
    setWslSystemDefaultHookTargetResolver({
      getDefaultWslDistro: hookMocks.getDefaultWslDistroMock,
      getWslHome: hookMocks.getWslHomeMock
    })
    clearRecordedClaudeWslSystemDefaultHookTargetsForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    setWslSystemDefaultHookTargetResolver(null)
  })

  it('removes Claude hooks from default, ambient, and saved account config dirs when disabled', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/ambient-claude')

    applyAgentStatusHooksEnabled(false, {
      claudeManagedAccounts: [
        managedClaudeAccount({
          id: 'host-account',
          managedAuthPath: '/tmp/orca/claude-host'
        }),
        managedClaudeAccount({
          id: 'wsl-account',
          managedAuthPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.orca\\claude',
          managedAuthRuntime: 'wsl',
          wslLinuxAuthPath: '/home/me/.orca/claude'
        }),
        managedClaudeAccount({
          id: 'incomplete-wsl-account',
          managedAuthPath: '\\\\wsl.localhost\\Debian\\home\\me\\.orca\\claude',
          managedAuthRuntime: 'wsl',
          wslLinuxAuthPath: null
        })
      ]
    } as never)

    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(1)
    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(2, {
      configDir: '/tmp/ambient-claude'
    })
    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(3, {
      configDir: '/tmp/orca/claude-host'
    })
    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(4, {
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.orca\\claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/me/.orca/claude'
    })
    expect(hookMocks.services.claude.remove).toHaveBeenCalledWith({
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/jin/.claude'
    })
    expect(hookMocks.services.claude.remove).toHaveBeenCalledTimes(5)
    expect(hookMocks.services.openClaude.remove).toHaveBeenCalledTimes(1)
  })

  it('dedupes repeated Claude config dirs before removing account-scoped hooks', () => {
    const defaultClaudeConfigDir = join(homedir(), '.claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', defaultClaudeConfigDir)

    applyAgentStatusHooksEnabled(false, {
      claudeManagedAccounts: [
        managedClaudeAccount({
          id: 'host-account-1',
          managedAuthPath: defaultClaudeConfigDir
        }),
        managedClaudeAccount({
          id: 'host-account-2',
          managedAuthPath: defaultClaudeConfigDir
        })
      ]
    } as never)

    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(1)
    expect(hookMocks.services.claude.remove).toHaveBeenCalledTimes(1)
  })

  it('continues removing saved Claude account hooks when one config dir fails', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/ambient-claude')
    hookMocks.services.claude.remove.mockImplementation((target?: { configDir?: string }) => {
      if (target?.configDir === '/tmp/ambient-claude') {
        throw new Error('permission denied')
      }
      return {
        agent: 'claude',
        state: 'not_installed',
        configPath: target?.configDir ? `${target.configDir}/settings.json` : '',
        managedHooksPresent: false,
        detail: null
      }
    })

    const statuses = applyAgentStatusHooksEnabled(false, {
      claudeManagedAccounts: [
        managedClaudeAccount({
          id: 'host-account',
          managedAuthPath: '/tmp/orca/claude-host'
        })
      ]
    } as never)

    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(1)
    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(2, {
      configDir: '/tmp/ambient-claude'
    })
    expect(hookMocks.services.claude.remove).toHaveBeenNthCalledWith(3, {
      configDir: '/tmp/orca/claude-host'
    })
    expect(statuses).toContainEqual(
      expect.objectContaining({
        agent: 'claude',
        state: 'error',
        detail: 'permission denied'
      })
    )
  })

  it('removes Claude hooks from WSL system-default config dirs when disabled', () => {
    applyAgentStatusHooksEnabled(false, {
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: null, Debian: 'saved-wsl-account' }
      },
      claudeManagedAccounts: [
        managedClaudeAccount({
          id: 'saved-wsl-account',
          managedAuthPath: '\\\\wsl.localhost\\Debian\\home\\jin\\.orca\\claude',
          managedAuthRuntime: 'wsl',
          wslLinuxAuthPath: '/home/jin/.orca/claude'
        })
      ]
    } as never)

    expect(hookMocks.services.claude.remove).toHaveBeenCalledWith({
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/jin/.claude'
    })
    expect(hookMocks.services.claude.remove).toHaveBeenCalledWith({
      configDir: '\\\\wsl.localhost\\Debian\\home\\jin\\.claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/jin/.claude'
    })
    expect(hookMocks.getWslHomeMock).toHaveBeenCalledWith('Ubuntu')
    expect(hookMocks.getWslHomeMock).toHaveBeenCalledWith('Debian')
  })

  it('removes recorded WSL system-default config dirs when settings have no WSL selection', () => {
    recordClaudeWslSystemDefaultHookTarget({
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/jin/.claude'
    })

    applyAgentStatusHooksEnabled(false, {
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
      claudeManagedAccounts: []
    } as never)

    expect(hookMocks.services.claude.remove).toHaveBeenCalledWith({
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/jin/.claude'
    })
  })

  it('removes WSL system-default config dirs from persisted WSL runtime settings', () => {
    applyAgentStatusHooksEnabled(false, {
      localAccountRuntime: 'wsl',
      localAccountWslDistro: 'Ubuntu',
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
      claudeManagedAccounts: []
    } as never)

    expect(hookMocks.services.claude.remove).toHaveBeenCalledWith({
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
      runtime: 'wsl',
      wslLinuxConfigDir: '/home/jin/.claude'
    })
  })

  it('can skip WSL system-default discovery during startup cleanup', () => {
    removeManagedAgentHooks(
      {
        localAccountRuntime: 'wsl',
        localAccountWslDistro: 'Ubuntu',
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Debian: null } },
        claudeManagedAccounts: []
      } as never,
      { includeWslSystemDefaultDiscovery: false }
    )

    expect(hookMocks.getWslHomeMock).not.toHaveBeenCalled()
    expect(hookMocks.getDefaultWslDistroMock).not.toHaveBeenCalled()
    expect(hookMocks.services.claude.remove).toHaveBeenCalledTimes(1)
  })
})
