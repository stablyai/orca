import { describe, expect, it } from 'vitest'
import { isProfileStateWriterRequest } from './profile-state-writer-protocol'

function prepared() {
  return {
    id: 1,
    command: 'write-prepared',
    write: {
      domainOrder: ['settings', 'workspaceSession'],
      replacements: [{ domain: 'settings', payload: '{}' }],
      patches: [
        {
          domain: 'workspaceSession',
          operations: [
            { kind: 'set', path: ['tabsByWorktree', 'w'], payload: '[]' },
            { kind: 'order', path: ['tabsByWorktree'], keys: ['w'] }
          ]
        }
      ],
      complete: true,
      runPayloads: ['{}']
    }
  }
}

describe('profile state writer request admission', () => {
  it('accepts dense prepared and legacy commands', () => {
    expect(isProfileStateWriterRequest(prepared())).toBe(true)
    expect(isProfileStateWriterRequest({ id: 1, command: 'write-domains', replacements: [] })).toBe(
      true
    )
    expect(
      isProfileStateWriterRequest({
        id: 1,
        command: 'write-automation',
        replacements: [],
        runPayloads: ['{}']
      })
    ).toBe(true)
  })

  it('rejects sparse and accessor vectors at the first reader without observing inherited indices', () => {
    const domains = prepared()
    domains.write.domainOrder = Array(1)
    const replacements = prepared()
    replacements.write.replacements = Array(1)
    const patches = prepared()
    patches.write.patches = Array(1)
    const operations = prepared()
    operations.write.patches[0].operations = Array(1)
    const path = prepared()
    path.write.patches[0].operations[0].path = Array(1)
    const keys = prepared()
    keys.write.patches[0].operations[1].keys = Array(1)
    const runs = prepared()
    runs.write.runPayloads = Array(1)
    const accessor = prepared()
    let observations = 0
    const getter = {
      configurable: true,
      get() {
        observations++
        return 'inherited'
      }
    }
    Object.defineProperty(accessor.write.domainOrder, '0', getter)
    const requests = [
      domains,
      replacements,
      patches,
      operations,
      path,
      keys,
      runs,
      accessor,
      { id: 1, command: 'write-domains', replacements: Array(1) },
      { id: 1, command: 'write-automation', replacements: [], runPayloads: Array(1) }
    ]
    let allRejected = true
    Object.defineProperty(Array.prototype, '0', getter)
    try {
      for (const request of requests) {
        allRejected &&= !isProfileStateWriterRequest(request)
      }
    } finally {
      Reflect.deleteProperty(Array.prototype, '0')
    }
    expect(allRejected).toBe(true)
    expect(observations).toBe(0)
  })
})
