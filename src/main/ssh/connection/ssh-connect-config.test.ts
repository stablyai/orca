import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { utils, type AuthenticationType } from 'ssh2'

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
  existsSync: (...args: unknown[]) => mockExistsSync(...args)
}))
vi.mock('../authentication/ssh-identity-file-read', () => ({
  readSshIdentityFileSync: (path: string) => {
    try {
      return { contents: mockReadFileSync(path) ?? null, problem: null }
    } catch (error) {
      return { contents: null, problem: String(error) }
    }
  }
}))

import { buildConnectConfig } from './ssh-connect-config'
import { findDefaultKeyFile } from '../authentication/ssh-auth-resolution'
import { resolveEffectiveProxy } from '../system-transport/ssh-proxy-command'
import { walkInitialAuthLadder } from './testing/ssh-connection-test-fixtures'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'

describe('findDefaultKeyFile', () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
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

  it('does not offer broad agent auth when IdentitiesOnly keys cannot be parsed', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('not-a-key'))
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: ['/home/user/.ssh/work_key'], identitiesOnly: true })
    )

    expect(config.agent).toBeUndefined()
    expect(config.privateKey).toEqual(Buffer.from('not-a-key'))
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

  it('defers an existing default key file to the no-agent retry', () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => String(p) === testHomePath('.ssh', 'id_ed25519')
    )
    mockReadFileSync.mockReturnValue(UNENCRYPTED_KEY)
    const config = buildConnectConfig(makeTarget(), null)
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(config.privateKey).toBeUndefined()
    expect(walkInitialAuthLadder(config, PASSWORD_HOST_METHODS)).toEqual(['none', 'agent'])
    // A post-agent second-factor challenge may use the stale pre-agent methods list; keep it offered.
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
    // Agent-only success must not touch FIFO/slow-mount identity files.
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
    // ssh2 rejects malformed keys before auth, so they cannot occupy the retry.
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
})

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
})
