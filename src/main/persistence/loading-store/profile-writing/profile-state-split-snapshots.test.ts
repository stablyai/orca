import { describe, expect, it, vi } from 'vitest'
import { ProfileStateSplitSnapshots } from './profile-state-split-snapshots'
import { capturePreparedProfileStateWrite } from './profile-state-prepared-write'
import {
  applyProfileStateDomainPatch,
  prepareProfileStateDomainPatches
} from '../../profile-state/documents/profile-state-domain-patches'

describe('profile state split capture', () => {
  it('keeps storage and acknowledged captures independent of later in-place edits', () => {
    const state = { workspaceSession: { tabsByWorktree: { a: [{ title: 'saved' }] } } }
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed(state)
    state.workspaceSession.tabsByWorktree.a[0].title = 'C'
    const captured = snapshots.capture('workspaceSession', state.workspaceSession)!
    expect(captured.patch.operations).toEqual([
      { kind: 'set', path: ['tabsByWorktree', 'a'], payload: '[{"title":"C"}]' }
    ])
    state.workspaceSession.tabsByWorktree.a[0].title = 'D'
    // The first capture failed: retry still compares against the admitted storage value.
    expect(snapshots.capture('workspaceSession', state.workspaceSession)!.patch.operations).toEqual(
      [{ kind: 'set', path: ['tabsByWorktree', 'a'], payload: '[{"title":"D"}]' }]
    )
    snapshots.acknowledge(new Map([['workspaceSession', captured.value]]))
    expect(snapshots.capture('workspaceSession', state.workspaceSession)!.patch.operations).toEqual(
      [{ kind: 'set', path: ['tabsByWorktree', 'a'], payload: '[{"title":"D"}]' }]
    )
    state.workspaceSession.tabsByWorktree.a[0].title = 'C'
    expect(snapshots.capture('workspaceSession', state.workspaceSession)!.patch.operations).toEqual(
      []
    )
  })

  it('preserves native JSON meaning, own keys and order through logical patches', () => {
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed({ workspaceSession: { tabsByWorktree: { a: [], b: [] }, keep: null } })
    const current: Record<string, unknown> = JSON.parse(
      '{"tabsByWorktree":{"b":[],"__proto__":[{"title":"own"}],"a":[]},"keep":{}}'
    )
    const captured = snapshots.capture('workspaceSession', current)!
    const [prepared] = prepareProfileStateDomainPatches([captured.patch])
    const result = applyProfileStateDomainPatch(
      { tabsByWorktree: { a: [], b: [] }, keep: null },
      prepared
    )
    expect(JSON.stringify(result)).toBe(
      '{"tabsByWorktree":{"b":[],"__proto__":[{"title":"own"}],"a":[]},"keep":{}}'
    )
    snapshots.acknowledge(new Map([['workspaceSession', captured.value]]))
    expect(
      snapshots.capture('workspaceSession', {
        ...current,
        optional: undefined
      })!.patch.operations
    ).toEqual([])
  })

  it('does not observe inherited properties missing from the captured baseline', () => {
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed({ workspaceSession: { tabsByWorktree: { w: [{}] } } })
    const current = { tabsByWorktree: { w: [{ probe: 1 }] } }
    let observations = 0
    Object.defineProperty(Object.prototype, 'probe', {
      configurable: true,
      get() {
        observations++
        throw new Error('unexpected inherited read')
      }
    })
    try {
      const captured = snapshots.capture('workspaceSession', current)!
      expect(captured.patch.operations).toEqual([
        { kind: 'set', path: ['tabsByWorktree', 'w'], payload: '[{"probe":1}]' }
      ])
      expect(observations).toBe(0)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'probe')
    }
  })

  it.each([
    ['worktreeMeta', '{"w":{"x":1}}', '{"w":{"x":1,"y":2}}'],
    ['workspaceSession', '{"tabsByWorktree":{"w":[1]}}', '{"tabsByWorktree":{"w":[1,2]}}'],
    [
      'workspaceSessionsByHostId',
      '{"host":{"tabsByWorktree":{"w":[1]}}}',
      '{"host":{"tabsByWorktree":{"w":[1,2]}}}'
    ]
  ])(
    'captures %s growth without observing numeric prototype accessors',
    (domain, before, after) => {
      const snapshots = new ProfileStateSplitSnapshots()
      snapshots.seed({ [domain]: JSON.parse(before) })
      const current = JSON.parse(after)
      let observations = 0
      let captured: ReturnType<ProfileStateSplitSnapshots['capture']>
      Object.defineProperty(Array.prototype, '1', {
        configurable: true,
        get() {
          observations++
          throw new Error('unexpected inherited index read')
        },
        set() {
          observations++
          throw new Error('unexpected inherited index write')
        }
      })
      try {
        captured = snapshots.capture(domain, current)
      } finally {
        Reflect.deleteProperty(Array.prototype, '1')
      }
      expect(observations).toBe(0)
      expect(captured).toBeDefined()
      const [patch] = prepareProfileStateDomainPatches([captured!.patch])
      expect(JSON.stringify(applyProfileStateDomainPatch(JSON.parse(before), patch))).toBe(after)
    }
  )

  it('rejects accessors without reading inherited descriptor values, including toJSON', () => {
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed({ workspaceSession: {} })
    const accessor = {
      get probe() {
        throw new Error('native only')
      }
    }
    const toJSON = {
      get toJSON() {
        throw new Error('native only')
      }
    }
    let observations = 0
    let first: ReturnType<ProfileStateSplitSnapshots['capture']>
    let second: ReturnType<ProfileStateSplitSnapshots['capture']>
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get() {
        observations++
        throw new Error('unexpected inherited descriptor read')
      }
    })
    try {
      first = snapshots.capture('workspaceSession', { a: { b: accessor } })
      second = snapshots.capture('workspaceSession', { a: { b: toJSON } })
    } finally {
      Reflect.deleteProperty(Object.prototype, 'value')
    }
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(observations).toBe(0)
  })

  it('seeds an absent root and rejects missing order targets without inherited reads', () => {
    const snapshots = new ProfileStateSplitSnapshots()
    const [patch] = prepareProfileStateDomainPatches([
      { domain: 'workspaceSession', operations: [{ kind: 'order', path: ['missing'], keys: [] }] }
    ])
    let observations = 0
    let captured: ReturnType<ProfileStateSplitSnapshots['capture']>
    let rejected: unknown
    const getter = {
      configurable: true,
      get() {
        observations++
        throw new Error('inherited read')
      }
    }
    Object.defineProperty(Object.prototype, 'workspaceSession', getter)
    Object.defineProperty(Object.prototype, 'missing', getter)
    try {
      snapshots.seed({})
      captured = snapshots.capture('workspaceSession', {})
      try {
        applyProfileStateDomainPatch({}, patch)
      } catch (error) {
        rejected = error
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, 'workspaceSession')
      Reflect.deleteProperty(Object.prototype, 'missing')
    }
    expect(observations).toBe(0)
    expect(captured?.patch.operations).toEqual([{ kind: 'set', path: [], payload: '{}' }])
    expect(rejected).toEqual(new Error('Profile state patch order does not cover its object'))
    expect(() =>
      prepareProfileStateDomainPatches([
        { domain: 'workspaceSession', operations: [{ kind: 'set', path: Array(1), payload: '1' }] }
      ])
    ).toThrow('operation is invalid')
    expect(() => prepareProfileStateDomainPatches(Array(1))).toThrow('must be an array')
    expect(() =>
      prepareProfileStateDomainPatches([{ domain: 'workspaceSession', operations: Array(1) }])
    ).toThrow('domain is invalid')
  })

  it('normalizes array undefined and nonfinite numbers without changing JSON values', () => {
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed({ workspaceSession: { a: { b: [null, null, 0] } } })
    expect(
      snapshots.capture('workspaceSession', {
        a: { b: [undefined, Number.NaN, -0] },
        optional: undefined
      })!.patch.operations
    ).toEqual([])
  })

  it('leaves hooks, proxies and sparse arrays to native serialization without observing them', () => {
    if (!('rawJSON' in JSON) || typeof JSON.rawJSON !== 'function') {
      throw new Error('Raw JSON fixture requires Node 24 or newer')
    }
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed({ workspaceSession: {} })
    let observations = 0
    const getter = {
      get title() {
        observations++
        return 'native'
      }
    }
    const hook = {
      toJSON() {
        observations++
        return 'native'
      }
    }
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          observations++
          return []
        }
      }
    )
    for (const value of [getter, hook, proxy, Array(1), JSON.rawJSON('42')]) {
      expect(snapshots.capture('workspaceSession', { a: { b: value } })).toBeUndefined()
    }
    expect(observations).toBe(0)
  })

  it.each([100, 1000])('sends only the changed leaf with %i workspace rows', (count) => {
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`w${index}`, [{ title: 'unchanged' }]])
    )
    const snapshots = new ProfileStateSplitSnapshots()
    snapshots.seed({ workspaceSession: { tabsByWorktree } })
    tabsByWorktree.w0[0].title = 'changed'
    const nativeStringify = JSON.stringify
    const serialized: string[] = []
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
      const payload = nativeStringify(value)
      if (payload !== undefined) {
        serialized.push(payload)
      }
      return payload
    })
    const captured = (() => {
      try {
        return snapshots.capture('workspaceSession', { tabsByWorktree })!
      } finally {
        stringify.mockRestore()
      }
    })()
    expect(serialized).toEqual(['[{"title":"changed"}]'])
    // One title update needs one small leaf; unrelated row payloads and full key vectors are unnecessary.
    expect(captured.patch).toEqual({
      domain: 'workspaceSession',
      operations: [
        { kind: 'set', path: ['tabsByWorktree', 'w0'], payload: '[{"title":"changed"}]' }
      ]
    })
  })

  it.each([false, true])(
    'preserves fallback hook timing and the exact committed snapshot (complete=%s)',
    (complete) => {
      const snapshots = new ProfileStateSplitSnapshots()
      snapshots.seed({ workspaceSession: {}, worktreeMeta: { a: { label: 'original' } } })
      const keys: string[] = []
      const stateToSave = {
        workspaceSession: {
          toJSON(key: string) {
            keys.push(key)
            stateToSave.worktreeMeta = { a: { label: 'later' } }
            return { activeTabId: 'hook' }
          }
        },
        worktreeMeta: { a: { label: 'original' } }
      }
      const captured = capturePreparedProfileStateWrite({
        snapshots,
        stateToSave,
        complete,
        secretSubs: [],
        protectedSecretUpdates: []
      })
      expect(keys).toEqual(['workspaceSession'])
      expect(captured.write?.replacements).toEqual([
        { domain: 'workspaceSession', payload: '{"activeTabId":"hook"}' }
      ])
      expect(captured.write?.patches).toEqual([
        {
          domain: 'worktreeMeta',
          operations: complete ? [] : [{ kind: 'set', path: ['a'], payload: '{"label":"later"}' }]
        }
      ])
      captured.acknowledge()
      expect(
        snapshots.capture('workspaceSession', { activeTabId: 'hook' })!.patch.operations
      ).toEqual([])
      expect(
        snapshots.capture('worktreeMeta', { a: { label: 'later' } })!.patch.operations
      ).toEqual(complete ? [{ kind: 'set', path: ['a'], payload: '{"label":"later"}' }] : [])
    }
  )
})
