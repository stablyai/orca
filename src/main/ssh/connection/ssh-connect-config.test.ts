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
