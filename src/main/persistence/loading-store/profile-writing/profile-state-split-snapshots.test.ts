import { describe, expect, it } from 'vitest'
import { ProfileStateSplitSnapshots } from './profile-state-split-snapshots'
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
    const current: unknown = JSON.parse(
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
        ...(current as Record<string, unknown>),
        optional: undefined
      })!.patch.operations
    ).toEqual([])
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
    const captured = snapshots.capture('workspaceSession', { tabsByWorktree })!
    // One title update needs one small leaf; unrelated row payloads and full key vectors are unnecessary.
    expect(captured.patch).toEqual({
      domain: 'workspaceSession',
      operations: [
        { kind: 'set', path: ['tabsByWorktree', 'w0'], payload: '[{"title":"changed"}]' }
      ]
    })
  })
})
