import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  utils,
  type AnyAuthMethod,
  type AuthenticationType,
  type AuthHandlerMiddleware,
  type ConnectConfig
} from 'ssh2'

vi.mock('os', () => ({
  homedir: () => '/home/testuser',
  tmpdir: () => '/tmp'
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args)
}))
vi.mock('./ssh-identity-file-read', () => ({
  readSshIdentityFileSync: (path: string) => {
    try {
      return { contents: mockReadFileSync(path) ?? null, problem: null }
    } catch (error) {
      return { contents: null, problem: String(error) }
    }
  }
}))

import { buildConnectConfig } from '../connection/ssh-connect-config'
import '../system-transport/system-ssh-args'
import { walkInitialAuthLadder } from '../connection/testing/ssh-connection-test-fixtures'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'

function makeTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-1',
    label: 'workbox',
    source: 'ssh-config',
    configHost: 'workbox',
    host: 'stale.example.com',
    port: 22,
    username: 'stale-user',
    identityFile: '/keys/stale-imported',
    ...overrides
  }
}

function makeResolved(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return {
    hostname: 'current.example.com',
    port: 2222,
    user: 'current-user',
    identityFile: ['/keys/unauthorized-first', '/keys/authorized-second'],
    identitiesOnly: true,
    forwardAgent: false,
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

function nextAuth(
  config: ConnectConfig,
  firstAttempt: boolean
): AuthenticationType | AnyAuthMethod | false {
  let result: AuthenticationType | AnyAuthMethod | false | undefined
  const handler = config.authHandler as AuthHandlerMiddleware
  handler(
    (firstAttempt ? null : ['publickey']) as unknown as AuthenticationType[],
    false,
    (attempt) => {
      result = attempt
    }
  )
  return result ?? false
}

function partialSuccessAuth(
  config: ConnectConfig,
  authsLeft: AuthenticationType[]
): AuthenticationType | AnyAuthMethod | false {
  let result: AuthenticationType | AnyAuthMethod | false | undefined
  const handler = config.authHandler as AuthHandlerMiddleware
  handler(authsLeft, true, (attempt) => {
    result = attempt
  })
  return result ?? false
}

describe('ordered SSH private-key authentication', () => {
  beforeEach(() => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
    mockReadFileSync.mockImplementation((path: unknown) => Buffer.from(String(path)))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('offers every fresh ssh -G IdentityFile in order and ignores the imported snapshot', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved(), {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    expect(nextAuth(config, false)).toMatchObject({
      type: 'publickey',
      key: Buffer.from('/keys/unauthorized-first')
    })
    expect(nextAuth(config, false)).toMatchObject({
      type: 'publickey',
      key: Buffer.from('/keys/authorized-second')
    })
    expect(nextAuth(config, false)).toBe('keyboard-interactive')
    expect(nextAuth(config, false)).toBe(false)
    expect(mockReadFileSync).not.toHaveBeenCalledWith('/keys/stale-imported')
  })

  it('still offers the ssh-agent when no readable key precedes it', () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const config = buildConnectConfig(makeTarget({ identityFile: undefined }), null)

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    // The queued agent observes signing for the challenge deferral; ssh2 still reads the socket.
    expect(config.agent).toBe('/tmp/agent.sock')
    expect(nextAuth(config, false)).toMatchObject({ type: 'agent' })
    expect(nextAuth(config, false)).toBe('keyboard-interactive')
  })

  it('keeps the password challenge on an agent attempt that carries a key, because no key retry follows it', () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    // Real key bytes, so '/keys/explicit' counts as unencrypted and IdentitiesOnly builds its agent.
    const keyBytes = Buffer.from(utils.generateKeyPairSync('ecdsa', { bits: 256 }).private)
    mockReadFileSync.mockReturnValue(keyBytes)
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({
        identityFile: [join('/home/testuser', '.ssh', 'id_ed25519'), '/keys/explicit']
      })
    )

    // The password retry reuses config; it must offer keyboard-interactive instead of deferring forever.
    expect(walkInitialAuthLadder(config, ['publickey', 'keyboard-interactive'])).toEqual([
      'none',
      'publickey',
      'agent',
      'keyboard-interactive'
    ])
  })

  it('stops re-offering methods the host no longer accepts after a partial success', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved(), {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    expect(partialSuccessAuth(config, ['keyboard-interactive'])).toBe('keyboard-interactive')
    expect(nextAuth(config, false)).toBe(false)
  })

  it('bounds the number of partial-success stages it will answer', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved(), {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    for (let stage = 0; stage < 4; stage += 1) {
      expect(partialSuccessAuth(config, ['keyboard-interactive'])).toBe('keyboard-interactive')
    }
    expect(partialSuccessAuth(config, ['keyboard-interactive'])).toBe(false)
  })

  it('resets ordered authentication for credential retries', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved(), {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    config.password = 'retry-password'
    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    expect(nextAuth(config, false)).toMatchObject({
      type: 'password',
      password: 'retry-password'
    })
    expect(nextAuth(config, false)).toMatchObject({
      type: 'publickey',
      key: Buffer.from('/keys/unauthorized-first')
    })
  })
})
