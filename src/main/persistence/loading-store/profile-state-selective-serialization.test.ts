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
