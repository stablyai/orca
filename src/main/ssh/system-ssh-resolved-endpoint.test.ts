import { describe, expect, it, vi, beforeEach } from 'vitest'

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
  ] as const)(
    'passes the effective ssh -G endpoint through wildcard %s system SSH',
    (_name, proxy) => {
      spawnSystemSshCommand(
        createTarget({
          source: 'ssh-config',
          configHost: 'prod',
          host: 'stale.example.com',
          port: 22,
          username: 'deploy',
          proxyCommand: 'ssh -W %h:%p stale-bastion'
        }),
        'echo ready',
        {
          wrapCommand: false,
          resolvedConfig: createResolvedConfig({
            hostname: 'resolved.example.com',
            port: 2222,
            user: 'vpnuser',
            ...proxy
          })
        }
      )

      const args = spawnMock.mock.calls[0][1] as string[]
      expect(args).toEqual(
        expect.arrayContaining([
          '-o',
          'Hostname=resolved.example.com',
          '-p',
          '2222',
          '-l',
          'vpnuser',
          '--',
          'prod',
          'echo ready'
        ])
      )
      expect(args).not.toContain('22')
      expect(args).not.toContain('deploy')
    }
  )

  it('lets fresh wildcard and Match defaults own the default port and imported user', () => {
    const args = buildSshArgs(
      createTarget({
        source: 'ssh-config',
        configHost: 'prod',
        host: 'stale.example.com',
        port: 22,
        username: 'deploy'
      }),
      {
        resolvedConfig: createResolvedConfig({ hostname: 'prod', port: 22, user: 'vpnuser' })
      }
    )

    expect(args).not.toContain('-p')
    expect(args).not.toContain('22')
    expect(args).toContain('-l')
    expect(args).toContain('vpnuser')
    expect(args).not.toContain('deploy')
  })
})
