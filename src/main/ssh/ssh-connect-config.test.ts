import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mock modules before imports
vi.mock('ssh2', () => ({
  Client: class MockSshClient {
    private handlers = new Map<string, (...args: unknown[]) => void>()
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler)
      return this
    }
    connect() {
      setTimeout(() => this.handlers.get('ready')?.(), 0)
    }
    end() {}
    destroy() {}
    exec() {}
    sftp() {}
    forwardOut(
      _srcIP: string,
      _srcPort: number,
      _dstIP: string,
      _dstPort: number,
      cb: (err: Error | null, channel: unknown) => void
    ) {
      cb(null, { on: vi.fn(), stdin: {}, stdout: { on: vi.fn() } })
    }
  }
}))

vi.mock('os', () => ({
  homedir: () => '/home/testuser'
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args)
}))

vi.mock('child_process', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return {
    ...original,
    execFileSync: vi.fn().mockImplementation(() => {
      throw new Error('not found')
    })
  }
})

vi.mock('./ssh-config-parser', () => ({
  resolveWithSshG: vi.fn().mockResolvedValue(null)
}))

import {
  buildConnectConfig,
  type SshConnectionCallbacks,
  type AuthHandlerState
} from './ssh-connection-utils'
import { resolveWithSshG } from './ssh-config-parser'
import type { SshTarget } from '../../shared/ssh-types'

describe('buildConnectConfig', () => {
  function makeTarget(overrides?: Partial<SshTarget>): SshTarget {
    return {
      id: 'target-1',
      label: 'testhost',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      ...overrides
    }
  }

  function makeCallbacks(overrides?: Partial<SshConnectionCallbacks>): SshConnectionCallbacks {
    return {
      onStateChange: vi.fn(),
      onHostKeyVerify: vi.fn().mockResolvedValue(true),
      onAuthChallenge: vi.fn().mockResolvedValue([]),
      onPasswordPrompt: vi.fn().mockResolvedValue(null),
      ...overrides
    }
  }

  function makeAuthState(overrides?: Partial<AuthHandlerState>): AuthHandlerState {
    return {
      agentAttempted: false,
      keyAttempted: false,
      defaultKeyAttempted: false,
      setState: vi.fn(),
      ...overrides
    }
  }

  beforeEach(() => {
    vi.mocked(resolveWithSshG).mockResolvedValue(null)
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('disables ssh2 readyTimeout (managed by manual pausable timeout)', async () => {
    const { config } = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
    expect(config.readyTimeout).toBe(0)
  })

  it('sets keepaliveInterval to 15s (matches VS Code)', async () => {
    const { config } = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
    expect(config.keepaliveInterval).toBe(15_000)
  })

  it('sets keepaliveCountMax to 4', async () => {
    const { config } = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
    expect(config.keepaliveCountMax).toBe(4)
  })

  it('uses target host, port, username by default', async () => {
    const { config } = await buildConnectConfig(
      makeTarget({ host: '1.2.3.4', port: 2222, username: 'admin' }),
      makeCallbacks(),
      makeAuthState()
    )
    expect(config.host).toBe('1.2.3.4')
    expect(config.port).toBe(2222)
    expect(config.username).toBe('admin')
  })

  it('falls back to ssh -G resolved config when target fields are empty', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue({
      hostname: 'resolved.example.com',
      user: 'resolveduser',
      port: 3333,
      identityFile: ['/home/testuser/.ssh/custom_key'],
      forwardAgent: false,
      proxyCommand: 'ssh -W %h:%p bastion'
    })

    const { config } = await buildConnectConfig(
      makeTarget({ host: '', port: 0, username: '' }),
      makeCallbacks(),
      makeAuthState()
    )
    expect(config.host).toBe('resolved.example.com')
    expect(config.port).toBe(3333)
    expect(config.username).toBe('resolveduser')
  })

  it('target fields take precedence over ssh -G resolved config', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue({
      hostname: 'resolved.example.com',
      user: 'resolveduser',
      port: 3333,
      identityFile: [],
      forwardAgent: false
    })

    const { config } = await buildConnectConfig(
      makeTarget({ host: 'explicit.com', port: 2222, username: 'explicit' }),
      makeCallbacks(),
      makeAuthState()
    )
    expect(config.host).toBe('explicit.com')
    expect(config.port).toBe(2222)
    expect(config.username).toBe('explicit')
  })

  it('calls resolveWithSshG with the target label', async () => {
    await buildConnectConfig(makeTarget({ label: 'myalias' }), makeCallbacks(), makeAuthState())
    expect(resolveWithSshG).toHaveBeenCalledWith('myalias')
  })

  it('gracefully handles ssh -G failure', async () => {
    vi.mocked(resolveWithSshG).mockRejectedValue(new Error('ssh not found'))
    const { config } = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
    expect(config.host).toBe('example.com')
  })

  it('sets SSH agent when SSH_AUTH_SOCK is available', async () => {
    const originalSock = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock'
    try {
      const { config } = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
      expect(config.agent).toBe('/tmp/ssh-agent.sock')
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock
      } else {
        delete process.env.SSH_AUTH_SOCK
      }
    }
  })

  it('returns null jumpClient and proxyProcess when neither is configured', async () => {
    const result = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
    expect(result.jumpClient).toBeNull()
    expect(result.proxyProcess).toBeNull()
  })

  it('hostVerifier calls pauseTimeout during user interaction', async () => {
    const pauseTimeout = vi.fn()
    const resumeTimeout = vi.fn()

    const { config } = await buildConnectConfig(makeTarget(), makeCallbacks(), {
      ...makeAuthState(),
      pauseTimeout,
      resumeTimeout
    })

    const hostVerifier = config.hostVerifier as (
      key: Buffer,
      verify: (accept: boolean) => void
    ) => void
    const verify = vi.fn()
    hostVerifier(Buffer.from('fake-key'), verify)

    // Should pause timeout for unknown host (ssh-keygen mock throws = host not known)
    expect(pauseTimeout).toHaveBeenCalled()
  })

  it('filters proxycommand "none" from ssh -G output', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue({
      hostname: 'example.com',
      port: 22,
      identityFile: [],
      forwardAgent: false,
      proxyCommand: 'none',
      proxyJump: 'none'
    })

    const result = await buildConnectConfig(makeTarget(), makeCallbacks(), makeAuthState())
    expect(result.proxyProcess).toBeNull()
    expect(result.jumpClient).toBeNull()
  })

  it('passes through real proxyJump from ssh -G when not "none"', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue({
      hostname: 'example.com',
      port: 22,
      identityFile: [],
      forwardAgent: false,
      proxyJump: 'bastion.example.com'
    })

    const result = await buildConnectConfig(
      makeTarget({ jumpHost: undefined }),
      makeCallbacks(),
      makeAuthState()
    )
    expect(result.jumpClient).not.toBeNull()
  })

  it('hostVerifier calls resumeTimeout after user accepts', async () => {
    const pauseTimeout = vi.fn()
    const resumeTimeout = vi.fn()
    const onHostKeyVerify = vi.fn().mockResolvedValue(true)

    const { config } = await buildConnectConfig(makeTarget(), makeCallbacks({ onHostKeyVerify }), {
      ...makeAuthState(),
      pauseTimeout,
      resumeTimeout
    })

    const hostVerifier = config.hostVerifier as (
      key: Buffer,
      verify: (accept: boolean) => void
    ) => void
    const verify = vi.fn()
    hostVerifier(Buffer.from('fake-key'), verify)

    await vi.waitFor(() => {
      expect(resumeTimeout).toHaveBeenCalled()
    })
    expect(verify).toHaveBeenCalledWith(true)
  })
})
