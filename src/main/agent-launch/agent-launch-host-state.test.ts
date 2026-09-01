import { describe, expect, it, vi } from 'vitest'
import {
  deriveAgentLaunchHostState,
  detectionBaseAgentsForLaunch,
  defaultTransportConfidentiality,
  describeSpawnExecutionHost,
  detectionUnavailable,
  executionHostIdForDescriptor,
  isRemoteForDescriptor,
  platformForDescriptor,
  resolveLocalTargetHomePath,
  toStockBaseAgentSet,
  type AgentLaunchHostDescriptor,
  type AgentLaunchHostStateDeps
} from './agent-launch-host-state'
import type { GlobalSettings } from '../../shared/types'

function makeDeps(overrides: Partial<AgentLaunchHostStateDeps> = {}): AgentLaunchHostStateDeps {
  return {
    getSettings: () => ({}) as GlobalSettings,
    getCatalogRevision: () => 3,
    detectStockBaseAgents: async () => ['claude', 'codex'],
    resolveTargetHomePath: async () => '/home/dev',
    ...overrides
  }
}

describe('executionHostIdForDescriptor', () => {
  it('maps each surface to its stable host id', () => {
    expect(executionHostIdForDescriptor({ kind: 'local', platform: 'darwin' })).toBe('local')
    expect(executionHostIdForDescriptor({ kind: 'wsl', distro: 'Ubuntu 22.04' })).toBe(
      'wsl:Ubuntu%2022.04'
    )
    expect(
      executionHostIdForDescriptor({
        kind: 'ssh',
        connectionId: 'my host',
        platform: 'linux'
      })
    ).toBe('ssh:my%20host')
    expect(
      executionHostIdForDescriptor({
        kind: 'runtime',
        environmentId: 'env/1',
        platform: 'linux'
      })
    ).toBe('runtime:env%2F1')
  })
})

describe('platformForDescriptor / isRemoteForDescriptor', () => {
  it('forces linux for WSL and keeps the named platform otherwise', () => {
    expect(platformForDescriptor({ kind: 'wsl', distro: 'Ubuntu' })).toBe('linux')
    expect(platformForDescriptor({ kind: 'local', platform: 'win32' })).toBe('win32')
    expect(
      platformForDescriptor({
        kind: 'ssh',
        connectionId: 'h',
        platform: 'linux'
      })
    ).toBe('linux')
  })

  it('treats SSH and default runtime as remote, local and WSL as local', () => {
    expect(isRemoteForDescriptor({ kind: 'local', platform: 'darwin' })).toBe(false)
    expect(isRemoteForDescriptor({ kind: 'wsl', distro: 'Ubuntu' })).toBe(false)
    expect(
      isRemoteForDescriptor({
        kind: 'ssh',
        connectionId: 'h',
        platform: 'linux'
      })
    ).toBe(true)
    expect(
      isRemoteForDescriptor({
        kind: 'runtime',
        environmentId: 'e',
        platform: 'linux'
      })
    ).toBe(true)
    expect(
      isRemoteForDescriptor({
        kind: 'runtime',
        environmentId: 'e',
        platform: 'linux',
        isRemote: false
      })
    ).toBe(false)
  })
})

describe('defaultTransportConfidentiality', () => {
  it('is undefined same-host, true for SSH, false for an unproven runtime channel', () => {
    expect(defaultTransportConfidentiality({ kind: 'local', platform: 'darwin' })).toBeUndefined()
    expect(defaultTransportConfidentiality({ kind: 'wsl', distro: 'Ubuntu' })).toBeUndefined()
    expect(
      defaultTransportConfidentiality({
        kind: 'ssh',
        connectionId: 'h',
        platform: 'linux'
      })
    ).toBe(true)
    expect(
      defaultTransportConfidentiality({
        kind: 'runtime',
        environmentId: 'e',
        platform: 'linux'
      })
    ).toBe(false)
  })
})

describe('toStockBaseAgentSet', () => {
  it('preserves the unknown/known-none distinction and filters to built-ins', () => {
    expect(toStockBaseAgentSet(null)).toBeNull()
    expect(toStockBaseAgentSet(undefined)).toBeNull()
    const none = toStockBaseAgentSet([])
    expect(none).not.toBeNull()
    expect(none!.size).toBe(0)
    const some = toStockBaseAgentSet(['claude', 'not-an-agent', 'codex'])
    expect([...some!].sort()).toEqual(['claude', 'codex'])
  })
})

describe('deriveAgentLaunchHostState', () => {
  it('derives a full local target with detection and home', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps(),
      { kind: 'local', platform: 'darwin' },
      { repoPath: '/repo', worktreePath: '/repo/wt' }
    )
    expect(state.target.platform).toBe('darwin')
    expect(state.target.isRemote).toBe(false)
    expect(state.target.executionHostId).toBe('local')
    expect(state.target.targetHomePath).toBe('/home/dev')
    expect([...state.target.detectedStockBaseAgents!].sort()).toEqual(['claude', 'codex'])
    // Same-host: confidentiality is omitted (undefined), not false.
    expect('transportConfidentialityAvailable' in state.target).toBe(false)
    expect(state.variables).toEqual({
      repoPath: '/repo',
      worktreePath: '/repo/wt'
    })
    expect(state.getCatalogRevision()).toBe(3)
  })

  it('carries an SSH target with confidential transport and derived host id', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveTargetHomePath: async () => '/home/remote' }),
      { kind: 'ssh', connectionId: 'box-1', platform: 'linux', shell: 'posix' },
      {}
    )
    expect(state.target.isRemote).toBe(true)
    expect(state.target.executionHostId).toBe('ssh:box-1')
    expect(state.target.shell).toBe('posix')
    expect(state.target.targetHomePath).toBe('/home/remote')
    expect(state.target.transportConfidentialityAvailable).toBe(true)
  })

  it('uses the target-owned SSH shell when the descriptor has no shell', async () => {
    const resolveStartupShell = vi.fn(async () => 'cmd' as const)
    const descriptor: AgentLaunchHostDescriptor = {
      kind: 'ssh',
      connectionId: 'box-1',
      platform: 'win32'
    }
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveStartupShell }),
      descriptor,
      {}
    )
    expect(resolveStartupShell).toHaveBeenCalledWith(descriptor)
    expect(state.target.shell).toBe('cmd')
  })

  it('does not replace a shell already proven by the descriptor', async () => {
    const resolveStartupShell = vi.fn(async () => 'powershell' as const)
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveStartupShell }),
      { kind: 'ssh', connectionId: 'box-1', platform: 'win32', shell: 'cmd' },
      {}
    )
    expect(resolveStartupShell).not.toHaveBeenCalled()
    expect(state.target.shell).toBe('cmd')
  })

  it('derives a WSL target as local linux with a wsl host id', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveTargetHomePath: async () => null }),
      { kind: 'wsl', distro: 'Ubuntu' },
      { repoPath: '/mnt/c/repo' }
    )
    expect(state.target.platform).toBe('linux')
    expect(state.target.isRemote).toBe(false)
    expect(state.target.executionHostId).toBe('wsl:Ubuntu')
    // Home unknown -> null so the resolver fails missing_target_home for ~ prefixes.
    expect(state.target.targetHomePath).toBeNull()
    expect('transportConfidentialityAvailable' in state.target).toBe(false)
  })

  it('fails closed on a runtime channel: remote, plaintext-conservative confidentiality', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps(),
      { kind: 'runtime', environmentId: 'sandbox-9', platform: 'linux' },
      {}
    )
    expect(state.target.isRemote).toBe(true)
    expect(state.target.executionHostId).toBe('runtime:sandbox-9')
    expect(state.target.transportConfidentialityAvailable).toBe(false)
  })

  it('honors an injected confidentiality override for an identified binding', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveTransportConfidentiality: () => true }),
      { kind: 'runtime', environmentId: 'sandbox-9', platform: 'linux' },
      {}
    )
    expect(state.target.transportConfidentialityAvailable).toBe(true)
  })

  it('passes honest unknowns through when detection and home are unavailable', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({
        detectStockBaseAgents: detectionUnavailable,
        resolveTargetHomePath: async () => null
      }),
      { kind: 'ssh', connectionId: 'box-1', platform: 'linux' },
      {}
    )
    expect(state.target.detectedStockBaseAgents).toBeNull()
    expect(state.target.targetHomePath).toBeNull()
  })

  it('normalizes missing variables to null', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps(),
      { kind: 'local', platform: 'linux' },
      {}
    )
    expect(state.variables).toEqual({ repoPath: null, worktreePath: null })
  })

  it('runs the async host reads exactly once', async () => {
    const detect = vi.fn(async () => ['claude'])
    const home = vi.fn(async () => '/home/dev')
    await deriveAgentLaunchHostState(
      makeDeps({ detectStockBaseAgents: detect, resolveTargetHomePath: home }),
      { kind: 'local', platform: 'linux' },
      {}
    )
    expect(detect).toHaveBeenCalledTimes(1)
    expect(home).toHaveBeenCalledTimes(1)
  })
})

describe('detectionBaseAgentsForLaunch', () => {
  const customId = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd' as const
  it('narrows only immutable built-in identities to one stock base', () => {
    expect(detectionBaseAgentsForLaunch({ selection: { kind: 'agent', agent: 'claude' } })).toEqual(
      ['claude']
    )
    expect(detectionBaseAgentsForLaunch({ selection: { kind: 'agent', agent: customId } })).toBe(
      undefined
    )
  })

  it('keeps full detection for mutable defaults and trusts snapshot base identity', () => {
    expect(detectionBaseAgentsForLaunch({ selection: { kind: 'default' } })).toBeUndefined()
    expect(
      detectionBaseAgentsForLaunch(
        { selection: { kind: 'default' } },
        {
          version: 1,
          requestedAgent: 'claude',
          baseAgent: 'claude',
          displayLabel: 'Claude',
          mode: 'built-in',
          argv: ['claude'],
          agentEnv: {},
          capturedEnvPolicy: 'none',
          target: {
            platform: 'linux',
            execution: 'native',
            shell: 'posix',
            isRemote: false,
            executionHostId: 'local'
          }
        }
      )
    ).toEqual(['claude'])
  })
})

describe('describeSpawnExecutionHost', () => {
  it('describes a local target with this machine platform', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: null,
      cwd: '/repo'
    })
    expect(descriptor.kind).toBe('local')
    expect(descriptor).toMatchObject({
      kind: 'local',
      platform: process.platform
    })
  })

  it('describes an SSH target and infers linux from a POSIX cwd', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: 'host-1',
      cwd: '/home/user/repo'
    })
    expect(descriptor).toEqual({
      kind: 'ssh',
      connectionId: 'host-1',
      platform: 'linux'
    })
  })

  it('infers win32 for an SSH target with a Windows-shaped cwd', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: 'host-1',
      cwd: 'C:\\Users\\me\\repo'
    })
    expect(descriptor).toEqual({
      kind: 'ssh',
      connectionId: 'host-1',
      platform: 'win32'
    })
  })

  it('defaults an SSH target to linux when the cwd is unknown', () => {
    const descriptor = describeSpawnExecutionHost({ connectionId: 'host-1' })
    expect(descriptor).toEqual({
      kind: 'ssh',
      connectionId: 'host-1',
      platform: 'linux'
    })
  })

  // A WSL UNC cwd runs a Linux userland; win32 here picks the Windows executable
  // variant and PowerShell-quotes a bash command line. Classifying it 'local'
  // would also host-id it `local`, leaving UNC/drive paths in the Linux argv.
  it('describes a WSL UNC cwd as its own wsl host with no Windows shell', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: null,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
      terminalWindowsShell: 'powershell'
    })
    expect(descriptor).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(platformForDescriptor(descriptor)).toBe('linux')
    expect(executionHostIdForDescriptor(descriptor)).toBe('wsl:Ubuntu')
  })

  // #12320: the pane's tab shell decides how the host quotes the launch argv;
  // PowerShell quotes typed into a cmd.exe tab reach the agent verbatim.
  it('quotes for the tab shell override ahead of the global Windows shell', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    try {
      expect(
        describeSpawnExecutionHost({
          connectionId: null,
          cwd: 'C:\\repo',
          shellOverride: 'cmd.exe',
          terminalWindowsShell: 'powershell.exe'
        })
      ).toEqual({ kind: 'local', platform: 'win32', shell: 'cmd' })
      expect(
        describeSpawnExecutionHost({
          connectionId: null,
          cwd: 'C:\\repo',
          terminalWindowsShell: 'powershell.exe'
        })
      ).toEqual({ kind: 'local', platform: 'win32', shell: 'powershell' })
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
    }
  })

  it('describes a legacy \\\\wsl$ UNC cwd as the same wsl host', () => {
    expect(
      describeSpawnExecutionHost({
        connectionId: null,
        cwd: '\\\\wsl$\\Debian\\srv\\app'
      })
    ).toEqual({ kind: 'wsl', distro: 'Debian' })
  })
})

describe('resolveLocalTargetHomePath', () => {
  it('returns a home dir for local and null for every other surface', async () => {
    const local: AgentLaunchHostDescriptor = {
      kind: 'local',
      platform: process.platform
    }
    await expect(resolveLocalTargetHomePath(local)).resolves.toEqual(expect.any(String))
    await expect(
      resolveLocalTargetHomePath({
        kind: 'ssh',
        connectionId: 'h',
        platform: 'linux'
      })
    ).resolves.toBeNull()
    await expect(resolveLocalTargetHomePath({ kind: 'wsl', distro: 'Ubuntu' })).resolves.toBeNull()
  })

  it('returns null for a divergent-platform local host, which owns its own $HOME', async () => {
    const divergent: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32'
    await expect(
      resolveLocalTargetHomePath({ kind: 'local', platform: divergent })
    ).resolves.toBeNull()
  })
})
