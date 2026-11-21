import { afterEach, describe, expect, it } from 'vitest'
import { createNativeHostWriteAdmission } from './browser-extension-native-host-write-admission'

const BODY_LIMIT = 64 * 1024 * 1024
const admissions: ReturnType<typeof createNativeHostWriteAdmission>[] = []
let evicted: number[] = []

function admission() {
  const index = admissions.length
  const writes = createNativeHostWriteAdmission(() => evicted.push(index))
  admissions.push(writes)
  return writes
}

afterEach(() => {
  for (const writes of admissions.splice(0)) {
    writes.close()
  }
  evicted = []
})

describe('native host write admission', () => {
  it('admits a max-size frame followed by another, then bounds host bytes', () => {
    const writes = admission()
    expect(writes.claim(BODY_LIMIT + 1)).toBeUndefined()
    const first = writes.claim(BODY_LIMIT)
    expect(first).toBeTypeOf('function')
    expect(writes.claim(BODY_LIMIT)).toBeTypeOf('function')
    expect(writes.claim(1)).toBeUndefined()
    first?.()
    expect(writes.claim(1)).toBeTypeOf('function')
    expect(evicted).toEqual([])
  })

  it('evicts the largest byte holder, not the claimant, when the process budget is full', () => {
    const stalled = [admission(), admission()]
    for (const writes of stalled) {
      expect(writes.claim(BODY_LIMIT)).toBeTypeOf('function')
      expect(writes.claim(BODY_LIMIT)).toBeTypeOf('function')
    }
    const fresh = admission()
    expect(fresh.claim(2)).toBeTypeOf('function')
    expect(evicted).toEqual([0])
    expect(stalled[0].claim(1)).toBeUndefined()
    expect(fresh.claim(BODY_LIMIT)).toBeTypeOf('function')
    expect(evicted).toEqual([0])
  })

  it('evicts the largest entry holder when process entries are full', () => {
    const hosts = Array.from({ length: 4 }, admission)
    for (const [index, host] of hosts.entries()) {
      for (let i = 0; i < (index === 2 ? 256 : 255); i++) {
        expect(host.claim(1)).toBeTypeOf('function')
      }
    }
    const fresh = admission()
    for (let i = 0; i < 3; i++) {
      expect(fresh.claim(1)).toBeTypeOf('function')
    }
    expect(evicted).toEqual([])
    expect(fresh.claim(1)).toBeTypeOf('function')
    expect(evicted).toEqual([2])
  })

  it('releases closed owners once, including late callbacks after successor admission', () => {
    const old = admission()
    const late = old.claim(BODY_LIMIT)
    expect(late).toBeTypeOf('function')
    old.close()
    old.close()
    late?.()
    late?.()
    expect(old.claim(1)).toBeUndefined()
    const hosts = [admission(), admission()]
    for (const host of hosts) {
      expect(host.claim(BODY_LIMIT)).toBeTypeOf('function')
      expect(host.claim(BODY_LIMIT)).toBeTypeOf('function')
    }
    expect(evicted).toEqual([])
    expect(admission().claim(1)).toBeTypeOf('function')
    expect(evicted).toEqual([1])
  })
})
