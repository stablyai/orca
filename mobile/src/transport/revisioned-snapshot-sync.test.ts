import { describe, expect, it } from 'vitest'
import {
  createRevisionedSnapshotSync,
  type SnapshotFetch,
  type SnapshotFetchOutcome
} from './revisioned-snapshot-sync'

type Snap = { revision: number; code?: string }

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferredFetch(): {
  fetch: SnapshotFetch<Snap>
  resolvers: Array<(outcome: SnapshotFetchOutcome<Snap>) => void>
  count: () => number
} {
  const resolvers: Array<(outcome: SnapshotFetchOutcome<Snap>) => void> = []
  const fetch: SnapshotFetch<Snap> = () =>
    new Promise((resolve) => {
      resolvers.push(resolve)
    })
  return { fetch, resolvers, count: () => resolvers.length }
}

describe('createRevisionedSnapshotSync', () => {
  it('coalesces a 100-event burst into at most two fetches, ending at the highest revision', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers, count } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    for (let revision = 1; revision <= 100; revision++) {
      conn.announce(revision)
    }
    // A burst issues one fetch; the other 99 announcements only raise the
    // highest-announced revision while that fetch is in flight.
    expect(count()).toBe(1)

    // First response is stale (server still catching up) so one follow-up fires.
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 1 } })
    await tick()
    expect(count()).toBe(2)

    resolvers[1]!({ kind: 'value', runtimeId: 'r', value: { revision: 100 } })
    await tick()
    expect(count()).toBe(2)
    expect(sync.getSnapshot('host')?.revision).toBe(100)
  })

  it('stops self-chaining when successful fetches make no revision progress', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers, count } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.announce(10)
    expect(count()).toBe(1)
    // Host persistently serves a revision below the announced one: the first
    // response drives one follow-up (progress from empty), but a second
    // no-progress response must not spin an unbounded RPC loop.
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 3 } })
    await tick()
    expect(count()).toBe(2)
    resolvers[1]!({ kind: 'value', runtimeId: 'r', value: { revision: 3 } })
    await tick()
    expect(count()).toBe(2)

    // A later announce re-drives exactly one fetch.
    conn.announce(11)
    expect(count()).toBe(3)
  })

  it('does not let a stale fetch response replace a newer cached snapshot', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 10 } })
    await tick()
    expect(sync.getSnapshot('host')?.revision).toBe(10)

    conn.announce(12)
    resolvers[1]!({ kind: 'value', runtimeId: 'r', value: { revision: 8 } })
    await tick()
    expect(sync.getSnapshot('host')?.revision).toBe(10)
  })

  it('replaces the cache unconditionally on reconnect hydrate', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 40 } })
    await tick()

    // A reconnect hydrate that returns an older revision still replaces it.
    conn.hydrate()
    resolvers[1]!({ kind: 'value', runtimeId: 'r', value: { revision: 12 } })
    await tick()
    expect(sync.getSnapshot('host')?.revision).toBe(12)
  })

  it('discards prior host state when the runtime changes even if the new revision is lower', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()

    const first = sync.openConnection('host', fetch)
    first.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'runtime-A', value: { revision: 50 } })
    await tick()
    expect(sync.getSnapshot('host')?.revision).toBe(50)

    // Same host id now reaches a different runtime with a lower revision.
    const second = sync.openConnection('host', fetch)
    second.hydrate()
    resolvers[1]!({ kind: 'value', runtimeId: 'runtime-B', value: { revision: 5 } })
    await tick()
    expect(sync.getSnapshot('host')?.revision).toBe(5)
  })

  it('keeps a lower revision for a different host without cross-host comparison', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()

    const connA = sync.openConnection('a', fetch)
    connA.hydrate()
    const connB = sync.openConnection('b', fetch)
    connB.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 50 } })
    resolvers[1]!({ kind: 'value', runtimeId: 'r', value: { revision: 5 } })
    await tick()

    expect(sync.getSnapshot('a')?.revision).toBe(50)
    expect(sync.getSnapshot('b')?.revision).toBe(5)
  })

  it('clears only the targeted host cache', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()

    const connA = sync.openConnection('a', fetch)
    connA.hydrate()
    const connB = sync.openConnection('b', fetch)
    connB.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 10 } })
    resolvers[1]!({ kind: 'value', runtimeId: 'r', value: { revision: 20 } })
    await tick()

    sync.clear('a')
    expect(sync.getSnapshot('a')).toBeNull()
    expect(sync.getSnapshot('b')?.revision).toBe(20)
  })

  // Every host disconnect clears its cache, so retaining the key would grow this
  // map by one entry per host ever connected to, for the process lifetime.
  it('drops the host key on clear, not just its cached value', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()

    for (let host = 0; host < 5; host++) {
      const conn = sync.openConnection(`host-${host}`, fetch)
      conn.hydrate()
      resolvers[host]!({ kind: 'value', runtimeId: 'r', value: { revision: 1 } })
      await tick()
      conn.dispose()
      sync.clear(`host-${host}`)
    }

    expect(sync.trackedHostCountForTests()).toBe(0)
  })

  it('still fences an in-flight fetch whose host was cleared', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.hydrate()
    sync.clear('host')
    // Resolves against the dropped state; must not resurrect the host entry.
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 7 } })
    await tick()

    expect(sync.getSnapshot('host')).toBeNull()
    expect(sync.trackedHostCountForTests()).toBe(0)
  })

  it('stores a projection error as the cached value so the UI can render repair copy', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 3 } })
    await tick()
    expect(sync.getSnapshot('host')).toMatchObject({ revision: 3 })
    expect(sync.getSnapshot('host')?.code).toBeUndefined()

    conn.announce(4)
    resolvers[1]!({
      kind: 'value',
      runtimeId: 'r',
      value: { revision: 4, code: 'agent_catalog_payload_too_large' }
    })
    await tick()
    expect(sync.getSnapshot('host')).toMatchObject({
      revision: 4,
      code: 'agent_catalog_payload_too_large'
    })
  })

  it('leaves the cached snapshot untouched on a transient unavailable response', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 5 } })
    await tick()

    conn.announce(7)
    resolvers[1]!({ kind: 'unavailable' })
    await tick()
    expect(sync.getSnapshot('host')?.revision).toBe(5)
  })

  it('drops the cached snapshot when the host answers that it publishes none', async () => {
    // A downgraded host would otherwise keep offering agents it can no longer launch.
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers, count } = deferredFetch()
    const conn = sync.openConnection('host', fetch)
    let notified = 0
    sync.subscribe('host', () => {
      notified += 1
    })

    conn.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 5 } })
    await tick()
    expect(notified).toBe(1)

    conn.announce(7)
    resolvers[1]!({ kind: 'absent', runtimeId: 'r' })
    await tick()
    expect(sync.getSnapshot('host')).toBeNull()
    expect(notified).toBe(2)
    // The cleared announcement must not self-chain another fetch.
    expect(count()).toBe(2)
  })

  it('ignores a fetch that resolves after its connection was disposed', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)

    conn.hydrate()
    conn.dispose()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 99 } })
    await tick()
    expect(sync.getSnapshot('host')).toBeNull()
  })

  it('notifies subscribers when the cached value changes', async () => {
    const sync = createRevisionedSnapshotSync<Snap>()
    const { fetch, resolvers } = deferredFetch()
    const conn = sync.openConnection('host', fetch)
    let notifications = 0
    const unsubscribe = sync.subscribe('host', () => {
      notifications++
    })

    conn.hydrate()
    resolvers[0]!({ kind: 'value', runtimeId: 'r', value: { revision: 1 } })
    await tick()
    expect(notifications).toBe(1)

    sync.clear('host')
    expect(notifications).toBe(2)
    unsubscribe()
  })
})
