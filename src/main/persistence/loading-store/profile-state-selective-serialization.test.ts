import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { serializeSelectiveProfileStateDomains } from './profile-state-authority-writes'
import { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'

function previousReplacements(state: Record<string, unknown>, domains: ReadonlySet<string>) {
  const parsed: unknown = JSON.parse(Buffer.from(JSON.stringify(state), 'utf8').toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Profile state payload must be a JSON object')
  }
  const entries = new Map(Object.entries(parsed))
  return [...domains].map((domain) => ({
    domain,
    payload: entries.has(domain) ? JSON.stringify(entries.get(domain)) : null
  }))
}

afterEach(() => vi.restoreAllMocks())

describe('selective profile domain serialization', () => {
  it('preserves deletion, JSON null, primitive roots, and escaped property values', () => {
    const escapedDomain = '雪"\\\ud800'
    const state = Object.fromEntries([
      ['undefined', undefined],
      ['function', () => 'omitted'],
      ['symbol', Symbol('omitted')],
      ['null', null],
      ['string', '雪😀\ud800\n"\\'],
      ['number', -0],
      ['nan', Number.NaN],
      ['infinity', Infinity],
      ['false', false],
      ['array', [undefined, null, Number.NaN, Symbol('omitted'), () => 'omitted']],
      ['date', new Date('2026-09-26T00:00:00Z')],
      ['__proto__', { own: true }],
      [escapedDomain, { '2': 'two', '1': 'one', omitted: undefined }]
    ])
    const domains = new Set([...Object.keys(state).toReversed(), 'missing', 'constructor'])

    expect(serializeSelectiveProfileStateDomains(state, domains)).toEqual(
      previousReplacements(state, domains)
    )
    expect(serializeSelectiveProfileStateDomains(state, new Set(['undefined', 'null']))).toEqual([
      { domain: 'undefined', payload: null },
      { domain: 'null', payload: 'null' }
    ])
  })

  it('passes the same keys and receiver to toJSON exactly once in state property order', () => {
    const calls: string[] = []
    const first = {
      text: 'before',
      toJSON(key: string) {
        expect(this).toBe(first)
        calls.push(key)
        second.text = 'after'
        return {
          text: this.text,
          child: { toJSON: (childKey: string) => childKey }
        }
      }
    }
    const second = {
      text: 'before',
      toJSON(key: string) {
        expect(this).toBe(second)
        calls.push(key)
        return this.text
      }
    }
    const omitted = { toJSON: (key: string) => void calls.push(key) }
    const state = { first, second, omitted }
    const domains = new Set(['second', 'omitted', 'first'])
    const expected = previousReplacements(state, domains)
    calls.length = 0
    second.text = 'before'

    expect(serializeSelectiveProfileStateDomains(state, domains)).toEqual(expected)
    expect(calls).toEqual(['first', 'second', 'omitted'])
  })

  it('still rejects cyclic and BigInt state before handing anything to the authority', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const value of [cyclic, 1n]) {
      expect(() =>
        serializeSelectiveProfileStateDomains({ session: value }, new Set(['session']))
      ).toThrow(TypeError)
    }
  })

  it('reads later domains after earlier toJSON hooks replace or delete them', () => {
    const buildState = () => {
      const state: Record<string, unknown> = {
        first: {
          toJSON() {
            state.replaced = { text: 'after' }
            delete state.deleted
            state.added = 'outside the captured keys'
            return 'first'
          }
        },
        replaced: { text: 'before' },
        deleted: 'before'
      }
      return state
    }
    const domains = new Set(['deleted', 'replaced', 'first', 'added'])
    const expected = previousReplacements(buildState(), domains)

    expect(expected).toEqual([
      { domain: 'deleted', payload: null },
      { domain: 'replaced', payload: '{"text":"after"}' },
      { domain: 'first', payload: '"first"' },
      { domain: 'added', payload: null }
    ])
    expect(serializeSelectiveProfileStateDomains(buildState(), domains)).toEqual(expected)
  })

  it('interleaves domain getters and toJSON hooks in JSON property order', () => {
    const buildState = (calls: string[]) => {
      let text = 'before'
      return {
        get first() {
          calls.push('get first')
          return {
            toJSON() {
              calls.push('serialize first')
              text = 'after'
              return 'first'
            }
          }
        },
        get second() {
          calls.push('get second')
          return text
        }
      }
    }
    const domains = new Set(['first', 'second'])
    const expectedCalls: string[] = []
    const expected = previousReplacements(buildState(expectedCalls), domains)
    const actualCalls: string[] = []

    expect(serializeSelectiveProfileStateDomains(buildState(actualCalls), domains)).toEqual(
      expected
    )
    expect(actualCalls).toEqual(expectedCalls)
    expect(actualCalls).toEqual(['get first', 'serialize first', 'get second'])
  })

  it.each(['1.0', '1e999', '9007199254740993', '"\\u0061"', '"\ud800"', '"\\uD800"'])(
    'normalizes raw JSON from a production domain hook like the previous path: %s',
    (raw) => {
      if (!('rawJSON' in JSON) || typeof JSON.rawJSON !== 'function') {
        throw new Error('This test requires native JSON.rawJSON support')
      }
      const rawValue: unknown = JSON.rawJSON(raw)
      const state = getDefaultPersistedState('/synthetic-profile')
      const serialize = vi.fn(() => ({ ...state.workspaceSession, extension: rawValue }))
      Object.defineProperty(state.workspaceSession, 'toJSON', { value: serialize })
      const domains = new Set(['workspaceSession'])
      const expected = previousReplacements({ workspaceSession: state.workspaceSession }, domains)
      serialize.mockClear()
      const serialization = new StateSerializationSecretHandlingOperations({
        state,
        protectedSecrets: new ProtectedSecretPersistence()
      })

      expect(serialization.buildStateDomainsToSave(domains)?.replacements).toEqual(expected)
      expect(serialize).toHaveBeenCalledExactlyOnceWith('workspaceSession')
    }
  )

  it('normalizes proxy key order without re-running its getters or toJSON', () => {
    const read = vi.fn(() => 'one')
    const value = new Proxy(
      {
        get 1() {
          return read()
        },
        2: 'two'
      },
      { ownKeys: () => ['2', '1'] }
    )
    const serialize = vi.fn(() => value)
    const state = { workspaceSession: { child: { toJSON: serialize } } }
    const domains = new Set(['workspaceSession'])
    const expected = previousReplacements(state, domains)
    read.mockClear()
    serialize.mockClear()

    expect(serializeSelectiveProfileStateDomains(state, domains)).toEqual(expected)
    expect(read).toHaveBeenCalledOnce()
    expect(serialize).toHaveBeenCalledExactlyOnceWith('child')
  })

  it('captures production domain references before hooks replace runtime fields', () => {
    const state = getDefaultPersistedState('/synthetic-profile')
    state.worktreeIdentityAliases = { captured: ['identity'] }
    const capturedAliases = state.worktreeIdentityAliases
    const capturedAutomations = state.automations
    Object.defineProperty(state.workspaceSession, 'toJSON', {
      value: () => {
        state.automations = []
        delete state.worktreeIdentityAliases
        return 'session'
      }
    })
    const domains = new Set(['workspaceSession', 'automations', 'worktreeIdentityAliases'])
    const serialization = new StateSerializationSecretHandlingOperations({
      state,
      protectedSecrets: new ProtectedSecretPersistence()
    })

    expect(serialization.buildStateDomainsToSave(domains)?.replacements).toEqual([
      { domain: 'workspaceSession', payload: '"session"' },
      { domain: 'automations', payload: JSON.stringify(capturedAutomations) },
      { domain: 'worktreeIdentityAliases', payload: JSON.stringify(capturedAliases) }
    ])
    expect(state.automations).not.toBe(capturedAutomations)
    expect(state.worktreeIdentityAliases).toBeUndefined()
  })

  it('serializes each selected domain once without an aggregate parse or UTF-8 buffer', () => {
    const state = getDefaultPersistedState('/synthetic-profile')
    state.workspaceSession.activeTabId = 'x'.repeat(200_000)
    const serialization = new StateSerializationSecretHandlingOperations({
      state,
      protectedSecrets: new ProtectedSecretPersistence()
    })
    const domains = new Set(['workspaceSession', 'automations', 'worktreeIdentityAliases'])
    const expected = previousReplacements(
      {
        workspaceSession: state.workspaceSession,
        automations: state.automations
      },
      domains
    )
    const stringify = vi.spyOn(JSON, 'stringify')
    const parse = vi.spyOn(JSON, 'parse')
    const encode = vi.spyOn(Buffer, 'from')

    const built = serialization.buildStateDomainsToSave(domains)
    const stringifiedObjects = stringify.mock.calls
      .map(([value]) => value)
      .filter((value) => value !== null && typeof value === 'object')
    const parseCount = parse.mock.calls.length
    const encodeCount = encode.mock.calls.length
    vi.restoreAllMocks()

    expect(built?.replacements).toEqual(expected)
    expect(stringifiedObjects.map((value) => Object.keys(value))).toEqual([
      ['workspaceSession'],
      ['automations']
    ])
    expect(parseCount).toBe(0)
    expect(encodeCount).toBe(0)
  })

  it('retains the full-write fallback for unknown domains or pending secret encryption', () => {
    const protectedSecrets = new ProtectedSecretPersistence()
    const serialization = new StateSerializationSecretHandlingOperations({
      state: getDefaultPersistedState('/synthetic-profile'),
      protectedSecrets
    })
    expect(serialization.buildStateDomainsToSave(new Set(['future-domain']))).toBeUndefined()
    vi.spyOn(protectedSecrets, 'hasPendingEncryption').mockReturnValue(true)
    expect(serialization.buildStateDomainsToSave(new Set(['workspaceSession']))).toBeUndefined()
  })
})
