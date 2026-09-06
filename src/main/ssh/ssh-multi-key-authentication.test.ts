import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  utils,
  type AnyAuthMethod,
  type AuthenticationType,
  type AuthHandlerMiddleware,
  type ConnectConfig,
  type ParsedKey
} from 'ssh2'

vi.mock('os', () => ({
  homedir: () => '/home/testuser',
  tmpdir: () => '/tmp'
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args)
}))

import { buildConnectConfig } from './ssh-connection-utils'
import { getPassphrasePrivateKeyPath } from './ssh-private-key-authentication'
import { buildSshArgs } from './system-ssh-args'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'

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
    expect(nextAuth(config, false)).toMatchObject({ type: 'agent', agent: '/tmp/agent.sock' })
    expect(nextAuth(config, false)).toBe('keyboard-interactive')
  })

  it('keeps explicit manual keys and unresolved imported keys as singular overrides', () => {
    const manual = buildConnectConfig(
      makeTarget({
        source: 'manual',
        configHost: 'manual.example.com',
        host: 'manual.example.com',
        identityFile: '/keys/manual'
      }),
      makeResolved(),
      { includeAgent: false, includePrivateKey: true }
    )
    const unresolvedImport = buildConnectConfig(makeTarget(), null, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(manual.privateKey).toEqual(Buffer.from('/keys/manual'))
    expect(unresolvedImport.privateKey).toEqual(Buffer.from('/keys/stale-imported'))
    // Single-key targets are still ordered by Orca's handler so an MFA host reaches
    // keyboard-interactive once per stage rather than once per connection.
    expect(nextAuth(manual, true)).toMatchObject({ type: 'none' })
    expect(nextAuth(manual, false)).toMatchObject({
      type: 'publickey',
      key: Buffer.from('/keys/manual')
    })
    expect(nextAuth(manual, false)).toBe('keyboard-interactive')
  })

  it('re-offers keyboard-interactive for each partial-success MFA stage', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved(), {
      includeAgent: false,
      includePrivateKey: true
    })
    config.password = 'stage-one'

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    expect(nextAuth(config, false)).toMatchObject({ type: 'password' })
    // Partial success: the host accepted the password and now offers only the challenge.
    expect(partialSuccessAuth(config, ['keyboard-interactive'])).toBe('keyboard-interactive')
    expect(partialSuccessAuth(config, ['keyboard-interactive'])).toBe('keyboard-interactive')
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

  it('offers every resolved key for a manually owned config-picker target', () => {
    const config = buildConnectConfig(
      makeTarget({
        source: 'manual',
        configHost: 'prod',
        host: 'prod.internal',
        identityFile: undefined
      }),
      makeResolved(),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(nextAuth(config, true)).toMatchObject({ type: 'none' })
    expect(nextAuth(config, false)).toMatchObject({
      type: 'publickey',
      key: Buffer.from('/keys/unauthorized-first')
    })
    expect(nextAuth(config, false)).toMatchObject({
      type: 'publickey',
      key: Buffer.from('/keys/authorized-second')
    })
  })

  it('resets ordered authentication for credential retries without extra key reads', () => {
    const config = buildConnectConfig(makeTarget(), makeResolved(), {
      includeAgent: false,
      includePrivateKey: true
    })
    const readsAfterResolution = mockReadFileSync.mock.calls.length

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
    expect(mockReadFileSync).toHaveBeenCalledTimes(readsAfterResolution)
  })

  it('keeps encrypted-key prompts tied to the matching fresh identity path', () => {
    vi.spyOn(utils, 'parseKey').mockImplementation((key) => {
      if (
        Buffer.from(key as Buffer)
          .toString()
          .includes('encrypted-second')
      ) {
        return new Error('Encrypted private OpenSSH key detected, but no passphrase given')
      }
      return { isPrivateKey: () => true } as ParsedKey
    })
    const config = buildConnectConfig(
      makeTarget(),
      makeResolved({ identityFile: ['/keys/first', '/keys/encrypted-second'] }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(getPassphrasePrivateKeyPath(config)).toBe('/keys/encrypted-second')
  })

  it('leaves config-host key authority to system OpenSSH', () => {
    const args = buildSshArgs(makeTarget(), { resolvedConfig: makeResolved() })

    expect(args.at(-1)).toBe('workbox')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('/keys/stale-imported')
    expect(args).not.toContain('/keys/unauthorized-first')
    expect(args).not.toContain('/keys/authorized-second')
  })
})
