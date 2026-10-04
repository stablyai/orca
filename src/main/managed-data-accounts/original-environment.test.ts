import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ManagedDataAccountService, getManagedDataAccountService } from './service'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'

const selected = {
  XDG_DATA_HOME: join(tmpdir(), 'managed-original', 'data'),
  XDG_STATE_HOME: join(tmpdir(), 'managed-original', 'state'),
  OPENCODE_AUTH_CONTENT: '',
  OPENCODE_DB: 'opencode.db'
}

function hash(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex')
}

function managedContext(
  service: ManagedDataAccountService,
  inline: string,
  profile = selected
): Record<string, string> {
  const env: Record<string, string> = {
    XDG_DATA_HOME: join(tmpdir(), 'system-original', 'data'),
    OPENCODE_AUTH_CONTENT: inline,
    OPENCODE_DB: 'system.db'
  }
  service.captureOriginalEnvironment(env, profile)
  return {
    ...env,
    ...profile,
    ORCA_DATA_ACCOUNT_DATA_HOME: profile.XDG_DATA_HOME,
    ORCA_DATA_ACCOUNT_STATE_HOME: profile.XDG_STATE_HOME,
    ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
  }
}

describe('host-private managed account originals', () => {
  it('restores multiple copied baselines without exposing either in a marker', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const first = managedContext(service, 'first-inline-baseline')
    const second = managedContext(service, 'second-inline-baseline')
    for (const [env, inline] of [
      [first, 'first-inline-baseline'],
      [second, 'second-inline-baseline']
    ] as const) {
      expect(Object.values(env).some((value) => value.includes(inline))).toBe(false)
      const copy = { ...env }
      service.restoreOriginalEnvironment(copy)
      expect(hash(copy.OPENCODE_AUTH_CONTENT) === hash(inline)).toBe(true)
      expect(copy.XDG_DATA_HOME).toBe(join(tmpdir(), 'system-original', 'data'))
      expect(copy.XDG_STATE_HOME).toBeUndefined()
      expect(copy.OPENCODE_DB).toBe('system.db')
      expect(copy.ORCA_DATA_ACCOUNT_ORIGINAL_ENV).toBeUndefined()
    }
  })

  it.each([
    { XDG_DATA_HOME: join(tmpdir(), 'independent-data') },
    { XDG_STATE_HOME: join(tmpdir(), 'independent-state') },
    { ORCA_DATA_ACCOUNT_DATA_HOME: join(tmpdir(), 'foreign-data') },
    { ORCA_DATA_ACCOUNT_STATE_HOME: join(tmpdir(), 'foreign-state') },
    { ORCA_DATA_ACCOUNT_PROVIDER: 'devin' },
    { OPENCODE_DB: 'independent.db' },
    { OPENCODE_AUTH_CONTENT: 'independent-inline' }
  ])('requires the recorded selection, beyond a caller-supplied reference: %o', (override) => {
    const service = new ManagedDataAccountService('private-original-root')
    const env = { ...managedContext(service, 'private-baseline'), ...override }
    service.restoreOriginalEnvironment(env)
    expect(Object.values(env).some((value) => value.includes('private-baseline'))).toBe(false)
    for (const [key, value] of Object.entries(override)) {
      if (!key.startsWith('ORCA_DATA_ACCOUNT_')) {
        expect(env[key]).toBe(value)
      }
    }
  })

  it('does not resolve a reference attached to a different otherwise valid profile', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const captured = managedContext(service, 'private-baseline')
    const foreign = managedContext(service, 'other-baseline', {
      ...selected,
      XDG_DATA_HOME: join(tmpdir(), 'different-profile', 'data'),
      XDG_STATE_HOME: join(tmpdir(), 'different-profile', 'state')
    })
    foreign.ORCA_DATA_ACCOUNT_ORIGINAL_ENV = captured.ORCA_DATA_ACCOUNT_ORIGINAL_ENV
    service.restoreOriginalEnvironment(foreign)
    expect(foreign.OPENCODE_AUTH_CONTENT).toBeUndefined()
  })

  it('does not resolve private references after service restart or explicit disposal', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const captured = managedContext(service, 'private-baseline')
    const restarted = new ManagedDataAccountService('private-original-root')
    const foreign = { ...captured }
    restarted.restoreOriginalEnvironment(foreign)
    expect(foreign.OPENCODE_AUTH_CONTENT).toBeUndefined()
    service.clearInlineAuthBaselines()
    service.restoreOriginalEnvironment(captured)
    expect(captured.OPENCODE_AUTH_CONTENT).toBeUndefined()
  })

  it('disposes sensitive originals when the host userData root changes or shuts down', () => {
    const original = getAppEnvironment()
    let root = join(tmpdir(), 'original-host-one')
    let shutdown: (() => void) | undefined
    try {
      setAppEnvironment({
        ...original,
        onWillQuit: (handler) => {
          shutdown = handler
        },
        getPath: (name) => (name === 'userData' ? root : original.getPath(name))
      })
      const first = getManagedDataAccountService()
      const captured = managedContext(first, 'private-baseline')
      root = join(tmpdir(), 'original-host-two')
      const second = getManagedDataAccountService()
      const copy = { ...captured }
      second.restoreOriginalEnvironment(copy)
      first.restoreOriginalEnvironment(captured)
      expect(copy.OPENCODE_AUTH_CONTENT).toBeUndefined()
      expect(captured.OPENCODE_AUTH_CONTENT).toBeUndefined()
      const current = managedContext(second, 'current-baseline')
      expect(shutdown).toBeDefined()
      shutdown?.()
      second.restoreOriginalEnvironment(current)
      expect(current.OPENCODE_AUTH_CONTENT).toBeUndefined()
    } finally {
      setAppEnvironment(original)
    }
  })

  it('deduplicates originals and refuses the 65th distinct value before changing its marker', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const first = managedContext(service, 'baseline-0')
    for (let i = 0; i < 100; i++) {
      expect(managedContext(service, 'baseline-0').ORCA_DATA_ACCOUNT_ORIGINAL_ENV).toBe(
        first.ORCA_DATA_ACCOUNT_ORIGINAL_ENV
      )
    }
    for (let i = 1; i < 64; i++) {
      managedContext(service, `baseline-${i}`)
    }
    const overflow = { OPENCODE_AUTH_CONTENT: 'overflow-baseline' }
    const before = hash(JSON.stringify(overflow))
    expect(() => service.captureOriginalEnvironment(overflow, selected)).toThrow('baseline limit')
    expect(hash(JSON.stringify(overflow)) === before).toBe(true)
    service.restoreOriginalEnvironment(first)
    expect(hash(first.OPENCODE_AUTH_CONTENT) === hash('baseline-0')).toBe(true)
  })

  it('bounds both UTF-8 bytes and selection bindings without evicting originals', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const oversized = { OPENCODE_AUTH_CONTENT: '€'.repeat(22_000) }
    expect(() => service.captureOriginalEnvironment(oversized, selected)).toThrow('launch limit')
    expect(Object.keys(oversized)).toEqual(['OPENCODE_AUTH_CONTENT'])
    const first = managedContext(service, 'same-baseline')
    for (let i = 1; i < 64; i++) {
      managedContext(service, 'same-baseline', {
        ...selected,
        XDG_DATA_HOME: join(tmpdir(), `profile-${i}`, 'data')
      })
    }
    expect(() =>
      managedContext(service, 'same-baseline', {
        ...selected,
        XDG_DATA_HOME: join(tmpdir(), 'overflow', 'data')
      })
    ).toThrow('context limit')
    service.restoreOriginalEnvironment(first)
    expect(hash(first.OPENCODE_AUTH_CONTENT) === hash('same-baseline')).toBe(true)
  })
})

describe('original marker compatibility', () => {
  it.each(['{', '[]', '{}', '{"inlineAuthReference":"invalid"}'])(
    'clears only proven overrides for malformed %s',
    (marker) => {
      const env = managedContext(
        new ManagedDataAccountService('private-original-root'),
        'private-baseline'
      )
      env.ORCA_DATA_ACCOUNT_ORIGINAL_ENV = marker
      env.XDG_STATE_HOME = join(tmpdir(), 'independent-state')
      restoreManagedDataAccountEnvironment(env)
      expect(env.XDG_DATA_HOME).toBeUndefined()
      expect(env.XDG_STATE_HOME).toBe(join(tmpdir(), 'independent-state'))
      expect(env.OPENCODE_DB).toBe('opencode.db')
      expect(env.ORCA_DATA_ACCOUNT_ORIGINAL_ENV).toBeUndefined()
    }
  )

  it('restores a recognized old plaintext snapshot while stripping it on a foreign relay', () => {
    const env = managedContext(
      new ManagedDataAccountService('private-original-root'),
      'private-baseline'
    )
    env.ORCA_DATA_ACCOUNT_ORIGINAL_ENV = JSON.stringify({
      XDG_DATA_HOME: join(tmpdir(), 'legacy-system-data'),
      XDG_STATE_HOME: null,
      OPENCODE_AUTH_CONTENT: 'legacy-inline',
      OPENCODE_DB: 'legacy.db'
    })
    const relay = { ...env }
    restoreManagedDataAccountEnvironment(env)
    restoreManagedDataAccountEnvironment(relay, false)
    expect(hash(env.OPENCODE_AUTH_CONTENT) === hash('legacy-inline')).toBe(true)
    expect(env.OPENCODE_DB).toBe('legacy.db')
    expect(relay.XDG_DATA_HOME).toBeUndefined()
    expect(relay.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(relay.ORCA_DATA_ACCOUNT_ORIGINAL_ENV).toBeUndefined()
  })

  it('preserves unknown old-client metadata and explicit System values without owned markers', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const env = managedContext(service, 'private-baseline')
    env.ORCA_DATA_ACCOUNT_PROVIDER = 'future-provider'
    env.ORCA_DATA_ACCOUNT_FUTURE_METADATA = 'opaque-metadata'
    const before = hash(JSON.stringify(env))
    service.restoreOriginalEnvironment(env)
    expect(hash(JSON.stringify(env)) === before).toBe(true)
    delete env.ORCA_DATA_ACCOUNT_DATA_HOME
    env.OPENCODE_AUTH_CONTENT = 'explicit-system-inline'
    service.restoreOriginalEnvironment(env)
    expect(hash(env.OPENCODE_AUTH_CONTENT) === hash('explicit-system-inline')).toBe(true)
    expect(env.ORCA_DATA_ACCOUNT_FUTURE_METADATA).toBe('opaque-metadata')
  })
})
