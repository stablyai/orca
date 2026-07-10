import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { BaseAgent, utils, type ParsedKey } from 'ssh2'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('os', () => ({
  homedir: () => '/home/testuser'
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn()
const TEST_HOME = '/home/testuser'

function testHomePath(...parts: string[]): string {
  return join(TEST_HOME, ...parts)
}

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args)
}))

import {
  isTransientError,
  isSystemSshFallbackError,
  isAuthError,
  isAgentFallbackError,
  sleep,
  shellEscape,
  findDefaultKeyFile,
  buildConnectConfig,
  resolveAgentSocket,
  resolveEffectiveProxy,
  CONNECT_TIMEOUT_MS,
  INITIAL_RETRY_ATTEMPTS,
  INITIAL_RETRY_DELAY_MS,
  RECONNECT_BACKOFF_MS,
  spawnProxyCommand
} from './ssh-connection-utils'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'

type MockProxyProcess = EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
}

function createMockProxyProcess(): MockProxyProcess {
  const proc = new EventEmitter() as MockProxyProcess
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk, cb?: (error?: Error | null) => void) => cb?.())
  })
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  return proc
}

// ── Constants ────────────────────────────────────────────────────────

describe('SSH connection constants', () => {
  it('CONNECT_TIMEOUT_MS is 30 seconds (matches VS Code)', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(30_000)
  })

  it('INITIAL_RETRY_ATTEMPTS is 5', () => {
    expect(INITIAL_RETRY_ATTEMPTS).toBe(5)
  })

  it('INITIAL_RETRY_DELAY_MS is 2 seconds', () => {
    expect(INITIAL_RETRY_DELAY_MS).toBe(2000)
  })

  it('RECONNECT_BACKOFF_MS has 9 entries', () => {
    expect(RECONNECT_BACKOFF_MS).toHaveLength(9)
  })
})

// ── isTransientError ─────────────────────────────────────────────────

describe('isTransientError', () => {
  it('returns true for ETIMEDOUT code', () => {
    const err = new Error('timed out') as NodeJS.ErrnoException
    err.code = 'ETIMEDOUT'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ECONNREFUSED code', () => {
    const err = new Error('refused') as NodeJS.ErrnoException
    err.code = 'ECONNREFUSED'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ECONNRESET code', () => {
    const err = new Error('reset') as NodeJS.ErrnoException
    err.code = 'ECONNRESET'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for EHOSTUNREACH code', () => {
    const err = new Error('host unreachable') as NodeJS.ErrnoException
    err.code = 'EHOSTUNREACH'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ENETUNREACH code', () => {
    const err = new Error('net unreachable') as NodeJS.ErrnoException
    err.code = 'ENETUNREACH'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for EAI_AGAIN code', () => {
    const err = new Error('dns') as NodeJS.ErrnoException
    err.code = 'EAI_AGAIN'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ETIMEDOUT in message (no code)', () => {
    expect(isTransientError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(true)
  })

  it('returns true for ECONNREFUSED in message', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 1.2.3.4:22'))).toBe(true)
  })

  it('returns true for ECONNRESET in message', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('returns false for auth errors', () => {
    expect(isTransientError(new Error('All configured authentication methods failed'))).toBe(false)
  })

  it('returns false for generic errors', () => {
    expect(isTransientError(new Error('something went wrong'))).toBe(false)
  })
})

// ── isSystemSshFallbackError ─────────────────────────────────────────

describe('isSystemSshFallbackError', () => {
  it('returns true for local reachability errors that system ssh may bypass', () => {
    const hostErr = new Error('host unreachable') as NodeJS.ErrnoException
    hostErr.code = 'EHOSTUNREACH'
    const netErr = new Error('net unreachable') as NodeJS.ErrnoException
    netErr.code = 'ENETUNREACH'

    expect(isSystemSshFallbackError(hostErr)).toBe(true)
    expect(isSystemSshFallbackError(netErr)).toBe(true)
  })

  it('returns false for transient errors that should keep the normal retry path', () => {
    const refused = new Error('refused') as NodeJS.ErrnoException
    refused.code = 'ECONNREFUSED'

    expect(isSystemSshFallbackError(refused)).toBe(false)
    expect(isSystemSshFallbackError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(false)
  })
})

// ── isAuthError ──────────────────────────────────────────────────────

describe('isAuthError', () => {
  it('returns true for "All configured authentication methods failed"', () => {
    expect(isAuthError(new Error('All configured authentication methods failed'))).toBe(true)
  })

  it('returns true for "Authentication failed"', () => {
    expect(isAuthError(new Error('Authentication failed'))).toBe(true)
  })

  it('returns true for client-authentication level', () => {
    const err = new Error('auth') as Error & { level: string }
    err.level = 'client-authentication'
    expect(isAuthError(err)).toBe(true)
  })

  it('returns true for server auth-attempt exhaustion', () => {
    expect(isAuthError(new Error('Received disconnect: Too many authentication failures'))).toBe(
      true
    )
  })

  it('returns false for transient errors', () => {
    expect(isAuthError(new Error('connect ETIMEDOUT'))).toBe(false)
  })
})

// ── isAgentFallbackError ────────────────────────────────────────────

describe('isAgentFallbackError', () => {
  it('returns true for ssh2 agent-level failures', () => {
    const err = new Error('Failed to connect to agent') as Error & { level: string }
    err.level = 'agent'
    expect(isAgentFallbackError(err)).toBe(true)
  })

  it('returns true when agent auth exhausts the server auth attempt limit', () => {
    expect(
      isAgentFallbackError(new Error('Received disconnect: Too many authentication failures'))
    ).toBe(true)
  })

  it('keeps unrelated transport errors out of agent fallback handling', () => {
    expect(isAgentFallbackError(new Error('connect ECONNRESET'))).toBe(false)
  })
})

// ── sleep ────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

// ── shellEscape ──────────────────────────────────────────────────────

describe('shellEscape', () => {
  it('wraps string in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'")
  })

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''")
  })

  it('handles special characters', () => {
    expect(shellEscape('foo bar; rm -rf /')).toBe("'foo bar; rm -rf /'")
  })
})

// ── findDefaultKeyFile ───────────────────────────────────────────────

describe('findDefaultKeyFile', () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
  })

  it('returns undefined when no default keys exist', () => {
    expect(findDefaultKeyFile()).toBeUndefined()
  })

  it('returns the first existing key file', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      return path === testHomePath('.ssh', 'id_ed25519')
    })
    mockReadFileSync.mockReturnValue(Buffer.from('key-contents'))

    const result = findDefaultKeyFile()
    expect(result).toBeDefined()
    expect(result!.path).toBe('~/.ssh/id_ed25519')
    expect(result!.contents).toEqual(Buffer.from('key-contents'))
  })

  it('probes keys in VS Code order: ed25519, rsa, ecdsa, dsa, xmss', () => {
    const checkedPaths: string[] = []
    mockExistsSync.mockImplementation((path: unknown) => {
      checkedPaths.push(String(path))
      return false
    })

    findDefaultKeyFile()

    expect(checkedPaths).toEqual([
      testHomePath('.ssh', 'id_ed25519'),
      testHomePath('.ssh', 'id_rsa'),
      testHomePath('.ssh', 'id_ecdsa'),
      testHomePath('.ssh', 'id_dsa'),
      testHomePath('.ssh', 'id_xmss')
    ])
  })

  it('skips unreadable key files and tries next', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      return path === testHomePath('.ssh', 'id_ed25519') || path === testHomePath('.ssh', 'id_rsa')
    })
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === testHomePath('.ssh', 'id_ed25519')) {
        throw new Error('permission denied')
      }
      return Buffer.from('rsa-key')
    })

    const result = findDefaultKeyFile()
    expect(result).toBeDefined()
    expect(result!.path).toBe('~/.ssh/id_rsa')
  })
})

// ── buildConnectConfig ──────────────────────────────────────────────

function makeTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'test-1',
    label: 'myhost',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function makeResolved(overrides?: Partial<SshResolvedConfig>): SshResolvedConfig {
  return {
    hostname: '10.0.0.1',
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

describe('buildConnectConfig', () => {
  const originalEnv = process.env.SSH_AUTH_SOCK

  beforeEach(() => {
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalEnv !== undefined) {
      process.env.SSH_AUTH_SOCK = originalEnv
    } else {
      delete process.env.SSH_AUTH_SOCK
    }
  })

  it('uses target host/port/username', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.host).toBe('example.com')
    expect(config.port).toBe(22)
    expect(config.username).toBe('deploy')
  })

  it('falls back to resolved config when target fields are empty', () => {
    const config = buildConnectConfig(
      makeTarget({ host: '', port: 0, username: '' }),
      makeResolved({ hostname: '10.0.0.1', port: 2222, user: 'admin' })
    )
    expect(config.host).toBe('10.0.0.1')
    expect(config.port).toBe(2222)
    expect(config.username).toBe('admin')
  })

  it('uses ssh -G HostName when a config-host target still points at its alias', () => {
    const config = buildConnectConfig(
      makeTarget({ label: 'workbox', configHost: 'workbox', host: 'workbox' }),
      makeResolved({ hostname: 'workbox.internal' })
    )

    expect(config.host).toBe('workbox.internal')
  })

  it('uses ssh -G Port when a config-host target still has the default port', () => {
    const config = buildConnectConfig(
      makeTarget({ configHost: 'workbox', host: 'workbox', port: 22 }),
      makeResolved({ port: 2202 })
    )

    expect(config.port).toBe(2202)
  })

  it('keeps explicit non-default target ports ahead of ssh -G Port', () => {
    const config = buildConnectConfig(
      makeTarget({ configHost: 'workbox', host: 'workbox', port: 2022 }),
      makeResolved({ port: 2202 })
    )

    expect(config.port).toBe(2022)
  })

  it('sets readyTimeout to CONNECT_TIMEOUT_MS', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.readyTimeout).toBe(30_000)
  })

  it('sets keepaliveInterval to 15s', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.keepaliveInterval).toBe(15_000)
  })

  it('uses agent auth when no explicit key and SSH_AUTH_SOCK is set', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.agent).toBe('/tmp/agent.sock')
  })

  it('enables agent forwarding when OpenSSH config requests it and an agent is available', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved({ forwardAgent: true }))

    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.agentForward).toBe(true)
  })

  it('does not enable agent forwarding without a usable agent', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    delete process.env.SSH_AUTH_SOCK

    try {
      const config = buildConnectConfig(makeTarget(), makeResolved({ forwardAgent: true }))
      expect(config.agent).toBeUndefined()
      expect(config.agentForward).toBeUndefined()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('uses configured IdentityAgent before SSH_AUTH_SOCK', () => {
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityAgent: '/tmp/one-password.sock' })
    )
    expect(config.agent).toBe('/tmp/one-password.sock')
  })

  it('prefers ssh -G resolved IdentityAgent for config-host targets', () => {
    const config = buildConnectConfig(
      makeTarget({ configHost: 'work', identityAgent: '%d/.1password/agent.sock' }),
      makeResolved({ identityAgent: testHomePath('.1password', 'agent.sock') })
    )
    expect(config.agent).toBe(testHomePath('.1password', 'agent.sock'))
  })

  it('allows IdentityAgent none to disable agent auth', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved({ identityAgent: 'none' }))
    expect(config.agent).toBeUndefined()
  })

  it('resolves IdentityAgent SSH_AUTH_SOCK from the environment', () => {
    expect(resolveAgentSocket(makeTarget(), makeResolved({ identityAgent: 'SSH_AUTH_SOCK' }))).toBe(
      '/tmp/agent.sock'
    )
    expect(
      resolveAgentSocket(makeTarget(), makeResolved({ identityAgent: '$SSH_AUTH_SOCK' }))
    ).toBe('/tmp/agent.sock')
  })

  it('uses the Windows OpenSSH agent pipe when no environment socket is available on Windows', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    delete process.env.SSH_AUTH_SOCK

    try {
      expect(resolveAgentSocket(makeTarget(), null)).toBe('\\\\.\\pipe\\openssh-ssh-agent')
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('wraps agent auth with IdentityFile filtering when IdentitiesOnly is enabled', () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === '/home/user/.ssh/work_key.pub') {
        return 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILI4wa2zRZoB26D015dsafYmu3jDCI7rh26bFXZrUiAp test-key'
      }
      throw new Error('unexpected read')
    })
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: ['/home/user/.ssh/work_key'], identitiesOnly: true })
    )

    expect(config.agent).toMatchObject({ kind: 'identity-filtered-agent' })
    expect(config.agent).toBeInstanceOf(BaseAgent)
    expect(config.privateKey).toBeUndefined()
    expect(mockReadFileSync).toHaveBeenCalledWith('/home/user/.ssh/work_key.pub')
  })

  it('does not offer broad agent auth when IdentitiesOnly keys cannot be parsed', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('not-a-key'))
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: ['/home/user/.ssh/work_key'], identitiesOnly: true })
    )

    expect(config.agent).toBeUndefined()
    expect(config.privateKey).toEqual(Buffer.from('not-a-key'))
  })

  it('includes unencrypted target.identityFile auth when an agent is available', () => {
    vi.spyOn(utils, 'parseKey').mockReturnValue({
      isPrivateKey: () => true
    } as ParsedKey)
    mockReadFileSync.mockReturnValue(Buffer.from('key'))
    const config = buildConnectConfig(makeTarget({ identityFile: '/home/user/.ssh/custom' }), null)
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toEqual(Buffer.from('key'))
    expect(mockReadFileSync).toHaveBeenCalledWith('/home/user/.ssh/custom')
  })

  it('defers encrypted target.identityFile auth when an agent is available', () => {
    vi.spyOn(utils, 'parseKey').mockReturnValue(
      new Error('Encrypted private OpenSSH key detected, but no passphrase given')
    )
    mockReadFileSync.mockReturnValue(Buffer.from('encrypted-key'))
    const config = buildConnectConfig(makeTarget({ identityFile: '/home/user/.ssh/custom' }), null)
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toBeUndefined()
    expect(mockReadFileSync).toHaveBeenCalledWith('/home/user/.ssh/custom')
  })

  it('uses keyFile auth when target.identityFile is set and no agent is available', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    delete process.env.SSH_AUTH_SOCK
    mockReadFileSync.mockReturnValue(Buffer.from('key'))
    try {
      const config = buildConnectConfig(
        makeTarget({ identityFile: '/home/user/.ssh/custom' }),
        null
      )
      expect(config.privateKey).toEqual(Buffer.from('key'))
      expect(config.agent).toBeUndefined()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('expands Windows-style target.identityFile before reading private key', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('key'))
    const config = buildConnectConfig(makeTarget({ identityFile: '~\\.ssh\\custom' }), null, {
      includeAgent: false,
      includePrivateKey: true
    })
    expect(config.privateKey).toEqual(Buffer.from('key'))
    expect(mockReadFileSync).toHaveBeenCalledWith(testHomePath('.ssh', 'custom'))
  })

  it('includes unencrypted resolved identityFile auth when an agent is available', () => {
    vi.spyOn(utils, 'parseKey').mockReturnValue({
      isPrivateKey: () => true
    } as ParsedKey)
    mockReadFileSync.mockReturnValue(Buffer.from('custom-key'))
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: ['/home/user/.ssh/work_key'] })
    )
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toEqual(Buffer.from('custom-key'))
  })

  it('uses agent auth without probing when resolved identityFile is a default path (expanded)', () => {
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: [testHomePath('.ssh', 'id_ed25519')] })
    )
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toBeUndefined()
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('does not probe default key files before agent auth', () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => String(p) === testHomePath('.ssh', 'id_ed25519')
    )
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toBeUndefined()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('provides fallback key when no agent is available', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    delete process.env.SSH_AUTH_SOCK
    mockExistsSync.mockImplementation(
      (p: unknown) => String(p) === testHomePath('.ssh', 'id_ed25519')
    )
    mockReadFileSync.mockReturnValue(Buffer.from('fallback'))
    try {
      const config = buildConnectConfig(makeTarget(), null)
      expect(config.agent).toBeUndefined()
      expect(config.privateKey).toEqual(Buffer.from('fallback'))
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('can force private key inclusion for the post-agent fallback path', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('key'))
    const config = buildConnectConfig(
      makeTarget({ identityFile: '/home/user/.ssh/custom' }),
      null,
      { includeAgent: false, includePrivateKey: true }
    )
    expect(config.agent).toBeUndefined()
    expect(config.privateKey).toEqual(Buffer.from('key'))
  })
})

// ── resolveEffectiveProxy ───────────────────────────────────────────

describe('resolveEffectiveProxy', () => {
  it('returns target.proxyCommand first', () => {
    const target = { ...makeTarget(), proxyCommand: 'cloudflared access ssh --hostname %h' }
    const resolved = makeResolved({ proxyCommand: 'other' })
    expect(resolveEffectiveProxy(target, resolved)).toEqual({
      kind: 'proxy-command',
      command: 'cloudflared access ssh --hostname %h'
    })
  })

  it('falls back to resolved proxyCommand', () => {
    expect(
      resolveEffectiveProxy(makeTarget(), makeResolved({ proxyCommand: 'ssh -W %h:%p gw' }))
    ).toEqual({
      kind: 'proxy-command',
      command: 'ssh -W %h:%p gw'
    })
  })

  it('returns structured jump-host config for target.jumpHost', () => {
    const target = { ...makeTarget(), jumpHost: 'bastion.example.com' }
    expect(resolveEffectiveProxy(target, null)).toEqual({
      kind: 'jump-host',
      jumpHost: 'bastion.example.com'
    })
  })

  it('returns structured jump-host config for resolved proxyJump', () => {
    expect(resolveEffectiveProxy(makeTarget(), makeResolved({ proxyJump: 'jump.host' }))).toEqual({
      kind: 'jump-host',
      jumpHost: 'jump.host'
    })
  })

  it('returns undefined when no proxy is configured', () => {
    expect(resolveEffectiveProxy(makeTarget(), null)).toBeUndefined()
  })
})

// ── spawnProxyCommand ───────────────────────────────────────────────

describe('spawnProxyCommand', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('removes proxy process listeners when the socket is destroyed', () => {
    const proc = createMockProxyProcess()
    spawnMock.mockReturnValue(proc)

    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    expect(proc.stdout.listenerCount('data')).toBe(1)
    expect(proc.stdout.listenerCount('end')).toBe(1)
    expect(proc.stdin.listenerCount('error')).toBe(1)
    expect(proc.listenerCount('error')).toBe(1)

    sock.destroy()

    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stdout.listenerCount('end')).toBe(0)
    expect(proc.stdin.listenerCount('error')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
  })
})
