import type { Dirent } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake tree whose reads finish only when a test releases them.
const fake = vi.hoisted(() => {
  const children = new Map<string, string[]>()
  const started: string[] = []
  const realpathCalls: string[] = []
  const pending: { path: string; release: () => void }[] = []
  return { children, started, realpathCalls, pending, inFlight: 0, peakInFlight: 0 }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    realpath: async (path: string) => {
      fake.realpathCalls.push(path)
      return `/real${path}`
    },
    readdir: (path: string) => {
      fake.started.push(path)
      fake.inFlight += 1
      fake.peakInFlight = Math.max(fake.peakInFlight, fake.inFlight)
      return new Promise((resolve) => {
        fake.pending.push({
          path,
          release: () => {
            fake.inFlight -= 1
            resolve(
              (fake.children.get(path) ?? []).map((name) => ({ name, isDirectory: () => true }))
            )
          }
        })
      })
    }
  }
})

const { createDirectoryReadAhead, MAX_IN_FLIGHT_DIRECTORY_READS, MAX_UNCLAIMED_DIRECTORY_READS } =
  await import('./skill-directory-read-ahead')

/** Every child directory is entered, in entry order. */
const enterAll = (_dirPath: string, entries: readonly Dirent[]): number[] =>
  entries.map((_, index) => index)

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function releaseAll(): Promise<void> {
  while (fake.pending.length > 0) {
    for (const read of fake.pending.splice(0)) {
      read.release()
    }
    await settle()
  }
}

function wideTree(root: string, width: number): string[] {
  const names = Array.from({ length: width }, (_, index) => `d${index}`)
  fake.children.set(root, names)
  return names.map((name) => join(root, name))
}

beforeEach(() => {
  fake.children.clear()
  fake.started.length = 0
  fake.realpathCalls.length = 0
  fake.pending.length = 0
  fake.inFlight = 0
  fake.peakInFlight = 0
})

afterEach(async () => {
  await releaseAll()
})

describe('createDirectoryReadAhead', () => {
  it('reads children before the walk claims them, within the in-flight bound', async () => {
    const root = '/tree'
    const children = wideTree(root, MAX_IN_FLIGHT_DIRECTORY_READS * 3)
    const readAhead = createDirectoryReadAhead({ enteredChildIndexes: enterAll })

    const rootRead = readAhead.claim(root, [])
    await settle()
    fake.pending.shift()?.release()
    await rootRead
    await settle()

    expect(fake.started.slice(1, 4)).toEqual(children.slice(0, 3))
    expect(fake.inFlight).toBe(MAX_IN_FLIGHT_DIRECTORY_READS)
    expect(fake.peakInFlight).toBe(MAX_IN_FLIGHT_DIRECTORY_READS)
  })

  it('keeps reading ahead as the walk claims more listings than the bounds hold', async () => {
    const root = '/tree'
    const children = wideTree(root, MAX_UNCLAIMED_DIRECTORY_READS * 2)
    const readAhead = createDirectoryReadAhead({ enteredChildIndexes: enterAll })
    const rootRead = readAhead.claim(root, [])
    await releaseAll()
    await rootRead

    let claimsThatStartedTheirOwnRead = 0
    for (const [index, child] of children.entries()) {
      const startedBefore = fake.started.includes(child)
      const read = readAhead.claim(child, [index])
      if (!startedBefore) {
        claimsThatStartedTheirOwnRead += 1
      }
      await releaseAll()
      await read
    }

    expect(claimsThatStartedTheirOwnRead).toBe(0)
  })

  it('starts reads in the order the walk will claim them', async () => {
    const root = '/tree'
    fake.children.set(root, ['a', 'b'])
    fake.children.set(join(root, 'a'), ['a1', 'a2'])
    const readAhead = createDirectoryReadAhead({ enteredChildIndexes: enterAll })

    const rootRead = readAhead.claim(root, [])
    await releaseAll()
    await rootRead

    // `a`'s children come before `b`, as in a depth-first walk.
    expect(fake.started).toEqual([
      root,
      join(root, 'a'),
      join(root, 'b'),
      join(root, 'a', 'a1'),
      join(root, 'a', 'a2')
    ])
  })

  it('resolves only the root; a plain child is its resolved parent plus its name', async () => {
    const root = '/tree'
    fake.children.set(root, ['a'])
    fake.children.set(join(root, 'a'), ['b'])
    const readAhead = createDirectoryReadAhead({ enteredChildIndexes: enterAll })

    const rootRead = readAhead.claim(root, [])
    await releaseAll()
    expect((await rootRead).resolvedPath).toBe('/real/tree')
    const child = await readAhead.claim(join(root, 'a'), [0])
    const grandchild = await readAhead.claim(join(root, 'a', 'b'), [0, 0])

    expect(child.resolvedPath).toBe(join('/real/tree', 'a'))
    expect(grandchild.resolvedPath).toBe(join('/real/tree', 'a', 'b'))
    expect(fake.realpathCalls).toEqual([root])
  })

  it('frees the slots of a dropped subtree for the reads the walk still needs', async () => {
    const root = '/tree'
    fake.children.set(root, ['skipped', 'kept'])
    // Enough unclaimed listings under `skipped` to fill the bound.
    wideTree(join(root, 'skipped'), MAX_UNCLAIMED_DIRECTORY_READS)
    const keptChildren = wideTree(join(root, 'kept'), 3)
    const readAhead = createDirectoryReadAhead({ enteredChildIndexes: enterAll })

    const rootRead = readAhead.claim(root, [])
    await releaseAll()
    await rootRead
    expect(fake.started).not.toEqual(expect.arrayContaining(keptChildren))

    // The walk found `skipped` already visited through another path and left it.
    await readAhead.claim(join(root, 'skipped'), [0])
    readAhead.drop(join(root, 'skipped'))
    await settle()

    expect(fake.started).toEqual(expect.arrayContaining(keptChildren))
    const skippedReads = fake.started.filter((path) => path.startsWith(join(root, 'skipped', '')))
    expect(skippedReads.length).toBeLessThanOrEqual(MAX_UNCLAIMED_DIRECTORY_READS)
  })

  it('starts none of the queued reads after its signal aborts', async () => {
    const root = '/tree'
    wideTree(root, MAX_IN_FLIGHT_DIRECTORY_READS * 2)
    const controller = new AbortController()
    const readAhead = createDirectoryReadAhead({
      signal: controller.signal,
      enteredChildIndexes: enterAll
    })

    const rootRead = readAhead.claim(root, [])
    await settle()
    fake.pending.shift()?.release()
    await rootRead
    await settle()
    controller.abort()
    await releaseAll()

    expect(fake.started).toHaveLength(1 + MAX_IN_FLIGHT_DIRECTORY_READS)
  })

  it('does not read into a subtree dropped while its read was in flight', async () => {
    const root = '/tree'
    fake.children.set(root, ['skipped'])
    const skippedChildren = wideTree(join(root, 'skipped'), 3)
    const readAhead = createDirectoryReadAhead({ enteredChildIndexes: enterAll })

    const rootRead = readAhead.claim(root, [])
    await settle()
    fake.pending.shift()?.release()
    await rootRead
    await settle()
    readAhead.drop(root)
    await releaseAll()

    expect(fake.started).toEqual([root, join(root, 'skipped')])
    expect(fake.started).not.toEqual(expect.arrayContaining(skippedChildren))
  })

  it('starts no more reads once its signal aborts', async () => {
    const root = '/tree'
    wideTree(root, 10)
    const controller = new AbortController()
    const readAhead = createDirectoryReadAhead({
      signal: controller.signal,
      enteredChildIndexes: enterAll
    })

    const rootRead = readAhead.claim(root, [])
    controller.abort()
    await releaseAll()
    await rootRead

    expect(fake.started).toEqual([root])
  })
})
