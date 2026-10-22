import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { BaseAgent, utils, type AuthenticationType, type ParsedKey } from 'ssh2'

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

import { buildConnectConfig } from './ssh-connect-config'
import { findDefaultKeyFile, resolveAgentSocket } from '../ssh-auth-resolution'
import { resolveEffectiveProxy } from '../ssh-proxy-command'
import { walkInitialAuthLadder } from './ssh-connection-test-fixtures'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'

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

  it('probes regular and FIDO2 keys in stable default order', () => {
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

  it('keeps a regular default ahead of a malformed FIDO2 default', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      return (
        path === testHomePath('.ssh', 'id_rsa') || path === testHomePath('.ssh', 'id_ed25519_sk')
      )
    })
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === testHomePath('.ssh', 'id_ed25519_sk')) {
        throw new Error('malformed FIDO2 key')
      }
      return Buffer.from('rsa-key')
    })

    expect(findDefaultKeyFile()).toEqual({
      path: '~/.ssh/id_rsa',
      contents: Buffer.from('rsa-key')
    })
  })

  it('leaves FIDO2 defaults out of the ssh2 private-key fallback', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      return path === testHomePath('.ssh', 'id_ed25519_sk')
    })

    expect(findDefaultKeyFile()).toBeUndefined()
    expect(mockReadFileSync).not.toHaveBeenCalled()
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

// What an OpenSSH host that collects its password through keyboard-interactive lists after 'none'.
const PASSWORD_HOST_METHODS: AuthenticationType[] = ['publickey', 'keyboard-interactive']
const UNENCRYPTED_KEY = Buffer.from(utils.generateKeyPairSync('ecdsa', { bits: 256 }).private)

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
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    updateHostKeys: 'no',
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

  it('uses fresh OpenSSH endpoint authority for imported config targets', () => {
    const config = buildConnectConfig(
      makeTarget({
        source: 'ssh-config',
        configHost: 'workbox',
        host: 'stale.example.com',
        port: 2022,
        username: 'stale-user'
      }),
      makeResolved({
        hostname: 'current.example.com',
        port: 2202,
        user: 'current-user'
      })
    )

    expect(config.host).toBe('current.example.com')
    expect(config.port).toBe(2202)
    expect(config.username).toBe('current-user')
  })

  it('keeps imported endpoint fields as the fallback when ssh -G is unavailable', () => {
    const config = buildConnectConfig(
      makeTarget({
        source: 'ssh-config',
        configHost: 'workbox',
        host: 'fallback.example.com',
        port: 2022,
        username: 'fallback-user'
      }),
      null
    )

    expect(config.host).toBe('fallback.example.com')
    expect(config.port).toBe(2022)
    expect(config.username).toBe('fallback-user')
  })

  it('sets readyTimeout to CONNECT_TIMEOUT_MS', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.readyTimeout).toBe(30_000)
  })

  it('sets keepaliveInterval to 15s', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.keepaliveInterval).toBe(15_000)
  })

  it('enables keyboard-interactive auth so MFA challenges can be answered', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.tryKeyboard).toBe(true)
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

  it('uses fresh OpenSSH IdentityFile authority for imported config targets', () => {
    mockReadFileSync.mockImplementation((path: unknown) => Buffer.from(String(path)))
    const config = buildConnectConfig(
      makeTarget({
        source: 'ssh-config',
        configHost: 'workbox',
        identityFile: '/home/user/.ssh/stale'
      }),
      makeResolved({ identityFile: ['/home/user/.ssh/current'] }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.privateKey).toEqual(Buffer.from('/home/user/.ssh/current'))
    expect(mockReadFileSync).toHaveBeenCalledWith('/home/user/.ssh/current')
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

  it('defers a default-path resolved identityFile to the no-agent retry', () => {
    mockReadFileSync.mockReturnValue(UNENCRYPTED_KEY)
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: [testHomePath('.ssh', 'id_ed25519')] })
    )
    expect(config.agent).toBe('/tmp/agent.sock')
    // No privateKey, so ssh2 cannot parse (and demand a passphrase for) the key before the agent
    // has been tried, and no password challenge, so the deferred key is reached before any dialog.
    expect(config.privateKey).toBeUndefined()
    expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual(['none', 'agent'])
  })

  it('defers an existing default key file to the no-agent retry', () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => String(p) === testHomePath('.ssh', 'id_ed25519')
    )
    mockReadFileSync.mockReturnValue(UNENCRYPTED_KEY)
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toBeUndefined()
    expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual(['none', 'agent'])
    // A host that does not list it can only demand it as a second factor, after the agent key
    // partially succeeds; ssh2 reports that with the stale pre-agent list, so it stays offered.
    expect(walkInitialAuthLadder(config, ['publickey'])).toEqual([
      'none',
      'agent',
      'keyboard-interactive'
    ])
  })

  it('reads a deferred default key only once the agent-first attempt reaches the challenge', () => {
    const defaultKeyPath = testHomePath('.ssh', 'id_ed25519')
    mockExistsSync.mockImplementation((p: unknown) => String(p) === defaultKeyPath)
    mockReadFileSync.mockReturnValue(UNENCRYPTED_KEY)
    const config = buildConnectConfig(makeTarget(), null)
    // A FIFO or slow mount there must not block an agent login that never needs the file.
    expect(mockReadFileSync).not.toHaveBeenCalledWith(defaultKeyPath)
    expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual(['none', 'agent'])
    expect(mockReadFileSync).toHaveBeenCalledWith(defaultKeyPath)
  })

  it('keeps the challenge when several keys wait, which could spend the retry auth budget', () => {
    mockReadFileSync.mockReturnValue(UNENCRYPTED_KEY)
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({
        identityFile: [testHomePath('.ssh', 'id_ed25519'), testHomePath('.ssh', 'id_ecdsa')]
      })
    )
    expect(config.privateKey).toBeUndefined()
    expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual([
      'none',
      'agent',
      'keyboard-interactive'
    ])
  })

  it('keeps the challenge on a keyboard-interactive-only host, where the deferred key cannot help', () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => String(p) === testHomePath('.ssh', 'id_ed25519')
    )
    mockReadFileSync.mockReturnValue(UNENCRYPTED_KEY)
    const config = buildConnectConfig(makeTarget(), null)
    expect(walkInitialAuthLadder(config, ['keyboard-interactive'])).toEqual([
      'none',
      'agent',
      'keyboard-interactive'
    ])
  })

  it('keeps the challenge when a deferred key file does not parse as a private key', () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => String(p) === testHomePath('.ssh', 'id_ed25519')
    )
    // ssh2 connect() throws on either before any auth, so the retry could never log in.
    const unusableKeys = [
      Buffer.from('not a private key'),
      Buffer.from(utils.generateKeyPairSync('ecdsa', { bits: 256 }).public)
    ]
    for (const contents of unusableKeys) {
      mockReadFileSync.mockReturnValue(contents)
      const config = buildConnectConfig(makeTarget(), null)
      expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual([
        'none',
        'agent',
        'keyboard-interactive'
      ])
    }
  })

  it('offers the keyboard-interactive challenge when the agent defers no key', () => {
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toBeUndefined()
    expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual([
      'none',
      'agent',
      'keyboard-interactive'
    ])
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

  it('uses fresh OpenSSH proxy authority for imported config targets', () => {
    const target = {
      ...makeTarget(),
      source: 'ssh-config' as const,
      configHost: 'workbox',
      proxyCommand: 'ssh -W %h:%p stale-bastion'
    }

    expect(resolveEffectiveProxy(target, makeResolved())).toBeUndefined()
    expect(
      resolveEffectiveProxy(target, makeResolved({ proxyCommand: 'ssh -W %h:%p current-bastion' }))
    ).toEqual({
      kind: 'proxy-command',
      command: 'ssh -W %h:%p current-bastion'
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
