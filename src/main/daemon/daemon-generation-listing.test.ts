import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import {
  answeredProcesses,
  listAnsweredProcesses,
  requireCompleteProcessListing
} from '../providers/pty-process-source-listing'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  DaemonListingDeadlineError,
  listDaemonProcessesBySource,
  listPerGeneration,
  type DaemonInventoryRead
} from './daemon-generation-listing'

function process(id: string): PtyProcessInfo {
  return { id, cwd: '', title: 'shell' }
}

function adapter(
  protocolVersion: number,
  read: () => Promise<DaemonInventoryRead<PtyProcessInfo>>,
  activeIds: string[] = []
): DaemonPtyAdapter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only protocolVersion, readProcesses and getActiveSessionIds.
  return {
    protocolVersion,
    readProcesses: vi.fn(read),
    getActiveSessionIds: () => activeIds
  } as unknown as DaemonPtyAdapter
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('listPerGeneration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the answered sources at the deadline while one source stays silent', async () => {
    vi.useFakeTimers()
    const listing = listPerGeneration<string, string>(
      ['current', 'frozen'],
      (source) =>
        source === 'current' ? Promise.resolve({ contact: 'live', items: ['a'] }) : never(),
      Date.now() + 3_000
    )
    await vi.advanceTimersByTimeAsync(3_000)

    const [current, frozen] = await listing
    expect(current).toEqual({ source: 'current', contact: 'live', items: ['a'] })
    expect(frozen).toMatchObject({ source: 'frozen', contact: 'unverifiable' })
    expect(frozen.contact === 'unverifiable' && frozen.error).toBeInstanceOf(
      DaemonListingDeadlineError
    )
  })

  it('keeps an exited source distinct from one that answered with nothing', async () => {
    const listing = await listPerGeneration<string, string>(['gone', 'empty'], async (source) =>
      source === 'gone' ? { contact: 'exited' } : { contact: 'live', items: [] }
    )

    expect(listing.map((entry) => entry.contact)).toEqual(['exited', 'live'])
  })

  it('keeps a read that throws before returning a promise to its own source', async () => {
    const listing = await listPerGeneration<string, string>(['broken', 'fine'], (source) => {
      if (source === 'broken') {
        throw new Error('not a daemon')
      }
      return Promise.resolve({ contact: 'live', items: ['a'] })
    })

    expect(listing.map((entry) => entry.contact)).toEqual(['unverifiable', 'live'])
  })

  it('reports a source whose read rejected as unverifiable, carrying its error', async () => {
    const failure = new Error('socket dead')
    const [entry] = await listPerGeneration<string, string>(['old'], async () => {
      throw failure
    })

    expect(entry).toEqual({ source: 'old', contact: 'unverifiable', error: failure })
  })
})

describe('listDaemonProcessesBySource', () => {
  it('names what a silent version was last known to hold, from routes and attached ids', async () => {
    const current = adapter(36, async () => ({ contact: 'live', items: [process('wt@@new')] }))
    const frozen = adapter(
      35,
      async () => {
        throw new Error('Request listSessions timed out')
      },
      ['wt@@attached']
    )
    const routes = new Map<string, IPtyProvider>([
      ['wt@@routed', frozen],
      ['wt@@new', current]
    ])

    const listings = await listDaemonProcessesBySource(
      { adapters: [current, frozen], current },
      routes
    )

    expect(listings[0]).toMatchObject({ protocolVersion: 36, isCurrent: true, contact: 'live' })
    expect(listings[1]).toMatchObject({ protocolVersion: 35, isCurrent: false })
    expect(listings[1].contact === 'unverifiable' && listings[1].lastKnownIds.sort()).toEqual([
      'wt@@attached',
      'wt@@routed'
    ])
    expect(answeredProcesses(listings).map((entry) => entry.id)).toEqual(['wt@@new'])
    expect(() => requireCompleteProcessListing(listings)).toThrow('Request listSessions timed out')
  })

  it('counts an exited version as complete and empty', async () => {
    const current = adapter(36, async () => ({ contact: 'live', items: [process('wt@@new')] }))
    const exited = adapter(35, async () => ({ contact: 'exited' }))

    const listings = await listDaemonProcessesBySource(
      { adapters: [current, exited], current },
      new Map()
    )

    expect(requireCompleteProcessListing(listings).map((entry) => entry.id)).toEqual(['wt@@new'])
  })
})

describe('a slow current version is never read as silent', () => {
  const slow = <T>(ms: number, value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms))

  function providerOf(current: DaemonPtyAdapter, previous: DaemonPtyAdapter): IPtyProvider {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listAnsweredProcesses reads only listProcessesBySource.
    return {
      listProcessesBySource: (opts?: { deadlineMs?: number; nonCurrentDeadlineMs?: number }) =>
        listDaemonProcessesBySource({ adapters: [current, previous], current }, new Map(), opts)
    } as unknown as IPtyProvider
  }

  it('waits for the current version while the 3 s cap ends the previous one', async () => {
    const current = adapter(36, () =>
      slow(3_500, { contact: 'live' as const, items: [process('wt@@current')] })
    )
    const frozen = adapter(35, never)
    const unverifiable: (number | null)[] = []

    const answered = await listAnsweredProcesses(
      providerOf(current, frozen),
      (source) => unverifiable.push(source.protocolVersion),
      Date.now() + 3_000
    )

    expect(answered.map((entry) => entry.id)).toEqual(['wt@@current'])
    expect(unverifiable).toEqual([35])
  }, 10_000)

  it('fails the listing as before when the current version itself does not answer', async () => {
    const hung = adapter(36, async () => {
      throw new Error('Request listSessions timed out')
    })
    const previous = adapter(35, async () => ({ contact: 'live', items: [process('wt@@old')] }))

    await expect(
      listAnsweredProcesses(providerOf(hung, previous), () => {}, Date.now() + 3_000)
    ).rejects.toThrow('Request listSessions timed out')
  })
})
