import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsSessionIdStore } from './analytics-session-id-store'

type WriteGate = { entered: (() => void) | null; wait: Promise<void> | null; fail: boolean }

const { writeGate } = vi.hoisted((): { writeGate: WriteGate } => ({
  writeGate: {
    entered: null,
    wait: null,
    fail: false
  }
}))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === 'w') {
        writeGate.entered?.()
        if (writeGate.wait) {
          await writeGate.wait
        }
        if (writeGate.fail) {
          throw new Error('simulated disk failure')
        }
      }
      return actual.open(...args)
    }
  }
})

let directory: string
let file: string
let stores: AnalyticsSessionIdStore[]
/** Track simulated restarts too; flush every store before fixture cleanup. */
function createStore(path = file): AnalyticsSessionIdStore {
  const store = new AnalyticsSessionIdStore(path)
  stores.push(store)
  return store
}
async function idFor(store: AnalyticsSessionIdStore, key: string) {
  const [id] = await store.getOrCreate([key])
  return id
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-analytics-session-id-'))
  file = join(directory, 'identities.json')
  stores = []
  writeGate.entered = null
  writeGate.wait = null
  writeGate.fail = false
})
afterEach(async () => {
  await Promise.all(stores.map((store) => store.flush()))
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('AnalyticsSessionIdStore', () => {
  it('handles concurrent requests for the same and different sessions without lost writes', async () => {
    const store = createStore()
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, index) => idFor(store, `session-${index % 10}`))
    )
    expect(new Set(ids).size).toBe(10)
    expect(ids.slice(0, 10)).toEqual(ids.slice(10))
    const restored = createStore()
    for (let index = 0; index < 10; index++) {
      expect(await idFor(restored, `session-${index}`)).toBe(ids[index])
    }
  })

  it('keeps all callers and shutdown waiting until the ID write completes', async () => {
    let release!: () => void
    let entered!: () => void
    writeGate.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    writeGate.entered = entered
    const store = createStore()
    let resolved = false
    let flushed = false
    const first = idFor(store, 'session').then((id) => {
      resolved = true
      return id
    })
    await writing
    const second = idFor(store, 'session')
    const flush = store.flush().then(() => {
      flushed = true
    })
    try {
      await Promise.resolve()
      expect(resolved).toBe(false)
      expect(flushed).toBe(false)
    } finally {
      release()
    }
    expect(await first).toBe(await second)
    await flush
    expect(flushed).toBe(true)
  })

  it('does not return an unpersisted ID on write failure and allows retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createStore()
    writeGate.fail = true
    await expect(idFor(store, 'session')).rejects.toThrow('simulated disk failure')
    expect(existsSync(file)).toBe(false)
    writeGate.fail = false
    const id = await idFor(store, 'session')
    expect(await idFor(createStore(), 'session')).toBe(id)
  })
})
