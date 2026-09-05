import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsSessionIdStore } from './analytics-session-id-store'

const { writeGate } = vi.hoisted(() => ({
  writeGate: {
    entered: null as (() => void) | null,
    wait: null as Promise<void> | null,
    fail: false
  }
}))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
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
    }) as typeof actual.open
  }
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
let directory: string
let file: string
let stores: AnalyticsSessionIdStore[]
function createStore(path = file): AnalyticsSessionIdStore {
  const store = new AnalyticsSessionIdStore(path)
  stores.push(store)
  return store
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
  it('is lazy and persists a random ID before returning it', async () => {
    const store = createStore()
    expect(existsSync(file)).toBe(false)
    const id = await store.getOrCreate('provider-session-123')
    expect(id).toMatch(UUID_V4)
    expect(id).not.toContain('provider-session')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      entries: [['provider-session-123', id]]
    })
    expect(await store.getOrCreate('provider-session-123')).toBe(id)
  })

  it('restores the ID after a restart or session resume', async () => {
    const original = createStore()
    const id = await original.getOrCreate('resumed-session')
    await original.flush()
    expect(await createStore().getOrCreate('resumed-session')).toBe(id)
  })

  it('handles concurrent requests for the same and different sessions without lost writes', async () => {
    const store = createStore()
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.getOrCreate(`session-${index % 10}`))
    )
    expect(new Set(ids).size).toBe(10)
    expect(ids.slice(0, 10)).toEqual(ids.slice(10))
    const restored = createStore()
    for (let index = 0; index < 10; index++) {
      expect(await restored.getOrCreate(`session-${index}`)).toBe(ids[index])
    }
  })

  it('isolates identical provider session IDs across provider and host/profile files', async () => {
    const ids = await Promise.all([
      createStore(join(directory, 'host-a', 'claude.json')).getOrCreate('same-session'),
      createStore(join(directory, 'host-a', 'codex.json')).getOrCreate('same-session'),
      createStore(join(directory, 'host-b', 'claude.json')).getOrCreate('same-session')
    ])
    expect(new Set(ids).size).toBe(3)
  })

  it.each(['', '   ', 'x'.repeat(1025)])(
    'rejects invalid keys without creating a mapping',
    async (key) => {
      await expect(createStore().getOrCreate(key)).rejects.toThrow('Invalid provider session ID')
      expect(existsSync(file)).toBe(false)
    }
  )

  it('handles prototype names and delimiter characters as ordinary opaque keys', async () => {
    const store = createStore()
    const keys = ['__proto__', 'constructor', 'a::b/c', 'a/b::c']
    const ids = await Promise.all(keys.map((key) => store.getOrCreate(key)))
    expect(new Set(ids).size).toBe(keys.length)
    const restored = createStore()
    expect(await Promise.all(keys.map((key) => restored.getOrCreate(key)))).toEqual(ids)
  })

  it.each([
    '{broken',
    JSON.stringify({ schemaVersion: 2, entries: [] }),
    JSON.stringify({ schemaVersion: 1, entries: [['session', 'provider-id']] }),
    JSON.stringify({ schemaVersion: 1, entries: [], extra: 'secret' })
  ])('fails closed on invalid persisted state without overwriting it', async (content) => {
    writeFileSync(file, content)
    await expect(createStore().getOrCreate('new-session')).rejects.toThrow(
      'Invalid analytics session identity file'
    )
    expect(readFileSync(file, 'utf8')).toBe(content)
  })

  it('rejects conflicting provider keys and analytics IDs', async () => {
    const first = '00000000-0000-4000-8000-000000000001'
    const second = '00000000-0000-4000-8000-000000000002'
    for (const entries of [
      [
        ['a', first],
        ['a', second]
      ],
      [
        ['a', first],
        ['b', first]
      ]
    ]) {
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries }))
      await expect(createStore().getOrCreate('new-session')).rejects.toThrow(
        'Duplicate analytics session identity'
      )
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
    const first = store.getOrCreate('session').then((id) => {
      resolved = true
      return id
    })
    await writing
    const second = store.getOrCreate('session')
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
    await expect(store.getOrCreate('session')).rejects.toThrow('simulated disk failure')
    expect(existsSync(file)).toBe(false)
    writeGate.fail = false
    const id = await store.getOrCreate('session')
    expect(await createStore().getOrCreate('session')).toBe(id)
  })
})
