import { describe, expect, it } from 'vitest'
import { WorkspaceSessionFieldCapture } from './workspace-session-field-capture'
import { capturePreparedProfileStateWrite } from './profile-state-prepared-write'
import { ProfileStateSaveIntent } from './profile-state-save-intent'
import {
  applyProfileStateDomainPatch,
  prepareProfileStateDomainPatches
} from '../../profile-state/documents/profile-state-domain-patches'

function fixture(before: unknown) {
  const fields = new WorkspaceSessionFieldCapture()
  fields.initialize()
  fields.acknowledge([fields.snapshot('workspaceSession', before)!])
  const dirtyDomains = new ProfileStateSaveIntent()
  dirtyDomains.addFields('workspaceSession')
  const capture = (next: unknown) =>
    capturePreparedProfileStateWrite({
      fields,
      dirtyDomains,
      stateToSave: { workspaceSession: next },
      complete: false,
      protectedSecretUpdates: []
    })
  return { fields, capture }
}

function apply(before: unknown, captured: ReturnType<typeof capturePreparedProfileStateWrite>) {
  if (!captured.write?.patches?.length) {
    throw new Error('Expected a session field patch')
  }
  return applyProfileStateDomainPatch(
    before,
    prepareProfileStateDomainPatches(captured.write.patches)[0]!
  )
}

describe('workspace session field serialization', () => {
  it('captures C independently of newer D and preserves whole-field omission and order', () => {
    const before = { tabsByWorktree: { a: [], b: [] }, activeTabId: 'a' }
    const { capture } = fixture(before)
    const c = capture({ activeTabId: 'b', tabsByWorktree: { b: [] } })
    const d = { activeTabId: 'a', tabsByWorktree: { a: [] } }
    c.acknowledge()
    expect(JSON.stringify(apply(before, c))).toBe('{"activeTabId":"b","tabsByWorktree":{"b":[]}}')
    expect(JSON.stringify(apply(apply(before, c), capture(d)))).toBe(
      '{"activeTabId":"a","tabsByWorktree":{"a":[]}}'
    )
  })

  it('never recertifies an exposed graph when an earlier capture is acknowledged', () => {
    const { fields, capture } = fixture({ activeTabId: 'a' })
    const c = capture({ activeTabId: 'b' })
    fields.expose('workspaceSession')
    c.acknowledge()
    const retained = { activeTabId: 'c', activeTabIdByWorktree: { w: 'after-ack' } }
    const next = capture(retained)
    expect(next.write?.replacements).toEqual([
      {
        domain: 'workspaceSession',
        payload: '{"activeTabId":"c","activeTabIdByWorktree":{"w":"after-ack"}}'
      }
    ])
  })

  it('leaves an unsupported incoming hook to the native field holder exactly once', () => {
    const { fields, capture } = fixture({ activeTabId: 'a' })
    const keys: string[] = []
    const incoming = {
      activeTabId: 'b',
      extra: {
        toJSON(key: string) {
          keys.push(key)
          return 'native'
        }
      }
    }
    fields.admit('workspaceSession', incoming)
    expect(keys).toEqual([])
    const next = capture(incoming)
    expect(keys).toEqual(['extra'])
    expect(next.write?.replacements).toEqual([
      { domain: 'workspaceSession', payload: '{"activeTabId":"b","extra":"native"}' }
    ])
  })

  it('rechecks inherited hooks without invoking them during eligibility checks', () => {
    const { capture } = fixture({ activeTabId: 'a' })
    let seen = ''
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value(key: string) {
        seen += `${key};`
        return key === 'workspaceSession' ? 'native' : this
      }
    })
    let next: ReturnType<typeof capture>
    try {
      next = capture({ activeTabId: 'b' })
    } finally {
      Reflect.deleteProperty(Object.prototype, 'toJSON')
    }
    expect(seen).toBe(';workspaceSession;')
    expect(next.write?.replacements).toEqual([{ domain: 'workspaceSession', payload: '"native"' }])
  })
})
