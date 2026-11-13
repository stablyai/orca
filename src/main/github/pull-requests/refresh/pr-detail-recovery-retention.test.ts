import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PRDetailRecoveryStartArgs } from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import { makeCandidate } from './pr-refresh-coordinator-test-harness'
import { PRDetailRecoveryTickets } from './pr-detail-recovery-tickets'
import { PRRefreshQueue } from './pr-refresh-queue'
import { PRRefreshRequestRegistry } from './pr-refresh-request-registry'
import { PRRefreshRetryState } from './pr-refresh-retry-state'

const candidate = makeCandidate()
const args: PRDetailRecoveryStartArgs = {
  clientEpoch: { scope: 'g1000.panel', counter: 1 },
  cacheKey: '/repo::feature/test',
  identity: {
    sourceEpoch: 'renderer:a',
    repoId: 'repo-1',
    repoPath: '/repo',
    worktreeId: 'wt-1',
    branch: 'feature/test',
    currentHeadOid: 'h1',
    executionHostId: null,
    provider: 'github',
    linkedPRNumber: null,
    fallbackPRNumber: null,
    fallbackPRSource: null,
    selectionRevision: ''
  }
}

function createTickets() {
  return new PRDetailRecoveryTickets({
    queue: new PRRefreshQueue(() => {}),
    requests: new PRRefreshRequestRegistry(),
    retry: new PRRefreshRetryState(),
    scheduleDrain: () => {}
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => vi.useRealTimers())

it('admits identity 1001 after retention without retiring an active operation', async () => {
  const tickets = createTickets()
  const active = tickets.start({ callerKey: 'active' }, args, candidate)
  for (let index = 0; index < 1001; index += 1) {
    const key = `paired:${index}`
    const ticket = tickets.start({ callerKey: key }, args, candidate)
    expect(ticket.terminal).toBeUndefined()
    tickets.cancel(key, ticket.ticketId)
    vi.setSystemTime(Date.now() + 60_001)
    await tickets.wait('active', active.ticketId, -1)
    tickets.tick()
  }
  expect(tickets.start({ callerKey: 'newest' }, args, candidate).phase).toBe('queued')
  expect(tickets.start({ callerKey: 'active' }, args, candidate).ticketId).toBe(active.ticketId)
  expect((await tickets.wait('active', active.ticketId, -1))?.terminal).toBeUndefined()
})

it('forgets old commits with their ticket and requires fresh preparation for a replayed start', () => {
  const tickets = createTickets()
  const caller = { callerKey: 'paired' }
  const first = tickets.start(caller, args, candidate)
  tickets.cancel(caller.callerKey, first.ticketId)
  expect(tickets.start(caller, args, candidate).ticketId).toBe(first.ticketId)
  vi.setSystemTime(61_001)
  tickets.tick()
  expect(
    tickets.commit(caller.callerKey, {
      ticketId: first.ticketId,
      prepareToken: 'old-prepare',
      publicationGrantId: 'old-grant'
    })
  ).toBeNull()
  const next = tickets.start(caller, args, candidate)
  expect(next.ticketId).not.toBe(first.ticketId)
  expect(next.phase).toBe('queued')
  expect(next.admitted).toBe(false)
  expect(next.preparation).toBeUndefined()
  expect(next.publicationGrantId).toBeUndefined()
})

it('retains expired unresolved reservations until the underlying resolver actually settles', async () => {
  const tickets = createTickets()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const resolve = async () => {
    await held
    return candidate
  }
  const pending = Array.from({ length: 1000 }, (_, index) =>
    tickets.startResolving({ callerKey: `paired:${index}` }, args, resolve)
  )
  const resumed = tickets.startResolving({ callerKey: 'paired:0' }, args, resolve)
  await Promise.resolve()
  vi.setSystemTime(61_001)
  tickets.tick()
  expect(
    (await Promise.all(pending)).every((snapshot) => snapshot.terminal?.kind === 'expired')
  ).toBe(true)
  expect((await resumed).terminal).toEqual({ kind: 'expired' })
  expect(tickets.start({ callerKey: 'new' }, args, candidate).terminal).toEqual({
    kind: 'not-admitted',
    reason: 'capacity'
  })
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(tickets.start({ callerKey: 'new' }, args, candidate).phase).toBe('queued')
})

it('closes a revoked pending start without waiting for its resolver and cannot revive it', async () => {
  const tickets = createTickets()
  const controller = new AbortController()
  const caller = {
    callerKey: 'paired',
    authority: { id: 'incarnation', signal: controller.signal }
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = tickets.startResolving(caller, args, async () => {
    await held
    return candidate
  })
  await Promise.resolve()
  controller.abort()
  expect((await pending).terminal).toEqual({ kind: 'cancelled' })
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(tickets.start(caller, args, candidate).terminal).toEqual({
    kind: 'not-admitted',
    reason: 'validation'
  })
})
