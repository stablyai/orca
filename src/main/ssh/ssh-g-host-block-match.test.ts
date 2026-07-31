import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { buildConnectConfig, resolveEffectiveProxy } from './ssh-connection-utils'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'

const LOCAL_ACCOUNT = 'localdev'

function storedTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-1',
    label: 'prod',
    source: 'ssh-config',
    configHost: 'prod',
    host: '10.0.0.5',
    port: 2222,
    username: 'deploy',
    identityFile: '/keys/prod',
    jumpHost: 'bastion',
    ...overrides
  }
}

// `ssh -G prod` output when no Host block matches the alias any more.
function unmatchedDefaults(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return {
    hostname: 'prod',
    user: LOCAL_ACCOUNT,
    port: 22,
    identityFile: [
      join('/home/testuser', '.ssh', 'id_rsa'),
      join('/home/testuser', '.ssh', 'id_ed25519')
    ],
    identitiesOnly: false,
    forwardAgent: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

function matchedBlock(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return unmatchedDefaults({
    hostname: '10.9.9.9',
    user: 'ops',
    port: 2200,
    identityFile: ['/keys/current-first', '/keys/current-second'],
    proxyJump: 'edge',
    ...overrides
  })
}

describe('ssh -G host-block matching', () => {
  beforeEach(() => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    vi.stubEnv('USER', LOCAL_ACCOUNT)
    vi.stubEnv('LOGNAME', LOCAL_ACCOUNT)
    vi.stubEnv('USERNAME', LOCAL_ACCOUNT)
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
    mockReadFileSync.mockImplementation((path: unknown) => Buffer.from(String(path)))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps stored endpoint fields when the alias no longer has a Host block', () => {
    const target = storedTarget()
    const resolved = unmatchedDefaults()

    const config = buildConnectConfig(target, resolved, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      proxy: resolveEffectiveProxy(target, resolved)
    }).toEqual({
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      privateKey: Buffer.from('/keys/prod'),
      proxy: { kind: 'jump-host', jumpHost: 'bastion' }
    })
  })

  it('keeps the stored ProxyCommand when the alias resolves to bare defaults', () => {
    const target = storedTarget({ jumpHost: undefined, proxyCommand: 'cf access ssh %h' })

    expect(resolveEffectiveProxy(target, unmatchedDefaults())).toEqual({
      kind: 'proxy-command',
      command: 'cf access ssh %h'
    })
  })

  it('applies fresh OpenSSH values when the Host block still matches', () => {
    const target = storedTarget()
    const resolved = matchedBlock()

    const config = buildConnectConfig(target, resolved, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(config.host).toBe('10.9.9.9')
    expect(config.port).toBe(2200)
    expect(config.username).toBe('ops')
    expect(resolveEffectiveProxy(target, resolved)).toEqual({
      kind: 'jump-host',
      jumpHost: 'edge'
    })
    // Why: #11297 — the first IdentityFile directive wins over the stored snapshot.
    expect(config.privateKey).toEqual(Buffer.from('/keys/current-first'))
    expect(mockReadFileSync).not.toHaveBeenCalledWith('/keys/prod')
  })

  // Every other field is a bare default, so only the rewritten HostName can carry the verdict.
  it('treats a rewritten HostName as a match when nothing else differs from the defaults', () => {
    const config = buildConnectConfig(
      storedTarget({ jumpHost: undefined }),
      unmatchedDefaults({ hostname: '10.9.9.9' }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.host).toBe('10.9.9.9')
  })

  it('treats a User directive as a match even when HostName echoes the alias', () => {
    const config = buildConnectConfig(
      storedTarget({ configHost: 'github.com', label: 'github.com', host: 'github.com' }),
      unmatchedDefaults({ hostname: 'github.com', user: 'git' }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.host).toBe('github.com')
    expect(config.username).toBe('git')
  })

  // Stored port stays non-22 so the legacy `target.port === 22` fallback can't supply the answer.
  it('treats a non-default Port as a match even when HostName echoes the alias', () => {
    const config = buildConnectConfig(
      storedTarget({ port: 2222 }),
      unmatchedDefaults({ port: 2022 }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.port).toBe(2022)
  })

  it('treats a ProxyJump directive as a match even when HostName echoes the alias', () => {
    const target = storedTarget({ jumpHost: 'stale-bastion' })

    expect(resolveEffectiveProxy(target, unmatchedDefaults({ proxyJump: 'edge' }))).toEqual({
      kind: 'jump-host',
      jumpHost: 'edge'
    })
  })

  it('treats a ProxyCommand directive as a match even when HostName echoes the alias', () => {
    const target = storedTarget({ jumpHost: undefined, proxyCommand: 'stale-proxy %h' })

    expect(
      resolveEffectiveProxy(target, unmatchedDefaults({ proxyCommand: 'cf access ssh %h' }))
    ).toEqual({
      kind: 'proxy-command',
      command: 'cf access ssh %h'
    })
  })

  // A launchd/systemd-spawned main process has no USER/LOGNAME/USERNAME, so the
  // resolved user proves nothing and the stored fields have to win.
  it('ignores the resolved user when the local account cannot be determined', () => {
    vi.stubEnv('USER', '')
    vi.stubEnv('LOGNAME', '')
    vi.stubEnv('USERNAME', '')

    const config = buildConnectConfig(
      storedTarget({ jumpHost: undefined }),
      unmatchedDefaults({ user: 'whoever' }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.username).toBe('deploy')
    expect(config.host).toBe('10.0.0.5')
  })

  it('keeps manual targets on their stored fields regardless of ssh -G output', () => {
    const config = buildConnectConfig(
      storedTarget({ source: 'manual', configHost: undefined }),
      matchedBlock(),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.host).toBe('10.0.0.5')
    expect(config.port).toBe(2222)
    expect(config.username).toBe('deploy')
  })
})
