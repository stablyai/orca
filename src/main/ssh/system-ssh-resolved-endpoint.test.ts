import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, spawnMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { buildSshArgs, spawnSystemSshCommand } from './ssh-system-fallback'
import type { SshTarget } from '../../shared/ssh-types'
import type { SystemSshResolvedConfig } from './ssh-control-socket'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createResolvedConfig(
  overrides?: Partial<SystemSshResolvedConfig>
): SystemSshResolvedConfig {
  return {
    hostname: 'example.com',
    port: 22,
    identityFile: [],
    forwardAgent: false,
    identitiesOnly: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

function getEndpointOptions(args: string[]): string[] {
  const destinationIndex = args.indexOf('--')
  const endpointOptions: string[] = []
  for (let i = 0; i < destinationIndex; i++) {
    const option = args[i]
    const value = args[i + 1]
    if (option === '-p' || option === '-l') {
      endpointOptions.push(option, value)
      i++
    } else if (option === '-o' && value?.startsWith('Hostname=')) {
      endpointOptions.push(option, value)
      i++
    }
  }
  return endpointOptions
}

describe('system SSH resolved endpoints', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()
    spawnMock.mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      pid: 12345,
      on: vi.fn(),
      kill: vi.fn()
    })
    existsSyncMock.mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
  })

  it.each([
    ['ProxyCommand', { proxyCommand: 'cloudflared access ssh --hostname %h' }],
    ['ProxyJump', { proxyJump: 'bastion' }],
    ['ProxyUseFdpass', { proxyUseFdpass: true }]
  ] as const)('uses the stored endpoint through wildcard %s system SSH', (_name, proxy) => {
    spawnSystemSshCommand(
      createTarget({
        source: 'ssh-config',
        configHost: 'prod',
        host: '10.0.0.5',
        port: 2222,
        username: 'deploy'
      }),
      'echo ready',
      {
        wrapCommand: false,
        resolvedConfig: createResolvedConfig({
          hostname: 'prod',
          port: 22,
          user: 'ops',
          ...proxy
        })
      }
    )

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(getEndpointOptions(args)).toEqual([
      '-p',
      '2222',
      '-o',
      'Hostname=10.0.0.5',
      '-l',
      'deploy'
    ])
    expect(args).toEqual(
      expect.arrayContaining([
        '-o',
        'Hostname=10.0.0.5',
        '-p',
        '2222',
        '-l',
        'deploy',
        '--',
        'prod',
        'echo ready'
      ])
    )
    expect(args).not.toContain('ops')
  })

  it('keeps alias-only arguments when the stored endpoint already matches the result', () => {
    const args = buildSshArgs(
      createTarget({
        source: 'ssh-config',
        configHost: 'prod',
        host: 'prod',
        port: 22,
        username: 'ops'
      }),
      {
        resolvedConfig: createResolvedConfig({
          hostname: 'prod',
          port: 22,
          user: 'ops',
          proxyCommand: 'cloudflared access ssh --hostname %h'
        })
      }
    )

    expect(args).toContain('--')
    expect(args).toContain('prod')
    expect(args).not.toContain('Hostname=prod')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-l')
    expect(getEndpointOptions(args)).toEqual([])
  })

  it('keeps a concrete resolved HostName authoritative', () => {
    const args = buildSshArgs(
      createTarget({
        source: 'ssh-config',
        configHost: 'prod',
        host: '10.0.0.5',
        port: 2222,
        username: 'deploy'
      }),
      {
        resolvedConfig: createResolvedConfig({
          hostname: 'current.example.com',
          port: 2200,
          user: 'current-user',
          proxyJump: 'bastion'
        })
      }
    )

    expect(getEndpointOptions(args)).toEqual([
      '-p',
      '2200',
      '-o',
      'Hostname=current.example.com',
      '-l',
      'current-user'
    ])
    expect(args).toEqual(
      expect.arrayContaining([
        '-o',
        'Hostname=current.example.com',
        '-p',
        '2200',
        '-l',
        'current-user',
        '--',
        'prod'
      ])
    )
    expect(args).not.toContain('10.0.0.5')
    expect(args).not.toContain('deploy')
  })
})
