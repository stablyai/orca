import { describe, expect, it, vi, beforeEach } from 'vitest'

const { existsSyncMock, spawnMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import {
  buildSshArgs,
  findSystemSsh,
  spawnSystemSsh,
  spawnSystemSshCommand
} from './ssh-system-fallback'
import type { SshTarget } from '../../shared/ssh-types'

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

describe('findSystemSsh', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
  })

  it('returns the first existing ssh path', () => {
    existsSyncMock.mockImplementation((p: string) => p === '/usr/bin/ssh')
    expect(findSystemSsh()).toBe('/usr/bin/ssh')
  })

  it('returns null when no ssh binary is found', () => {
    existsSyncMock.mockReturnValue(false)
    expect(findSystemSsh()).toBeNull()
  })
})

describe('spawnSystemSsh', () => {
  let mockProc: {
    stdin: {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
    }
    stdout: { on: ReturnType<typeof vi.fn> }
    stderr: { on: ReturnType<typeof vi.fn> }
    pid: number
    on: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()

    mockProc = {
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      pid: 12345,
      on: vi.fn(),
      kill: vi.fn()
    }
    spawnMock.mockReturnValue(mockProc)
    existsSyncMock.mockImplementation((p: string) => p === '/usr/bin/ssh')
  })

  it('spawns ssh with correct arguments for basic target', () => {
    spawnSystemSsh(createTarget())

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ssh',
      expect.arrayContaining(['-T', 'deploy@example.com']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('includes port flag when not 22', () => {
    spawnSystemSsh(createTarget({ port: 2222 }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-p')
    expect(args).toContain('2222')
  })

  it('does not include port flag when port is 22', () => {
    spawnSystemSsh(createTarget({ port: 22 }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('-p')
  })

  it('includes identity file flag', () => {
    spawnSystemSsh(createTarget({ identityFile: '/home/user/.ssh/id_ed25519' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-i')
    expect(args).toContain('/home/user/.ssh/id_ed25519')
  })

  it('includes identity agent option', () => {
    spawnSystemSsh(createTarget({ identityAgent: '/home/user/.1password/agent.sock' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args).toContain('IdentityAgent=/home/user/.1password/agent.sock')
  })

  it('includes identities only option', () => {
    spawnSystemSsh(createTarget({ identitiesOnly: true }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args).toContain('IdentitiesOnly=yes')
  })

  it('includes jump host flag', () => {
    spawnSystemSsh(createTarget({ jumpHost: 'bastion.example.com' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-J')
    expect(args).toContain('bastion.example.com')
  })

  it('includes proxy command flag', () => {
    spawnSystemSsh(createTarget({ proxyCommand: 'ssh -W %h:%p bastion' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args).toContain('ProxyCommand=ssh -W %h:%p bastion')
  })

  it('uses configHost without resolved field overrides so OpenSSH sees the Host block', () => {
    const args = buildSshArgs(
      createTarget({
        configHost: 'fdpass-host',
        host: 'resolved.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '/tmp/key',
        identityAgent: '/tmp/agent.sock',
        proxyCommand: 'ignored'
      })
    )

    expect(args).toContain('deploy@fdpass-host')
    expect(args).not.toContain('resolved.example.com')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('IdentityAgent=/tmp/agent.sock')
    expect(args).not.toContain('ProxyCommand=ignored')
  })

  it('spawns a remote command through the system ssh target', () => {
    spawnSystemSshCommand(createTarget({ configHost: 'fdpass-host' }), 'echo hello')

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ssh',
      expect.arrayContaining(['--', 'deploy@fdpass-host', "exec /bin/sh -c 'echo hello'"]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('exposes child stdin so remote commands receive EOF', () => {
    const channel = spawnSystemSshCommand(createTarget(), 'cat > /tmp/file')

    channel.stdin.end('contents')

    expect(mockProc.stdin.end).toHaveBeenCalledWith('contents')
  })

  it('throws when no system ssh is found', () => {
    existsSyncMock.mockReturnValue(false)
    expect(() => spawnSystemSsh(createTarget())).toThrow('No system ssh binary found')
  })

  it('returns a process wrapper with kill and onExit', () => {
    const result = spawnSystemSsh(createTarget())

    expect(result.pid).toBe(12345)
    expect(typeof result.kill).toBe('function')
    expect(typeof result.onExit).toBe('function')
  })
})
