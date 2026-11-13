import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRDetailRecoveryStartArgs } from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('../../client/lookup/pr-for-branch-outcome', () =>
  moduleMocks.clientModuleMock(coordinatorMocks)
)
vi.mock('../../repositories/github-api-repository-remote-probe', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('../../api/rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

// The coordinator test reset pins fake time here.
const START_AT = 1_000
const { getPRForBranchOutcomeMock, repositoryRateLimitGuardMock } = coordinatorMocks
const CALLER = { callerKey: 'ipc:1', windowId: 1 }
const H1 = makeCandidate({
  fallbackPRNumber: 7,
  fallbackPRSource: 'hosted-review',
  currentHeadOid: 'h1'
})
const H2 = makeCandidate({
  fallbackPRNumber: 7,
  fallbackPRSource: 'hosted-review',
  currentHeadOid: 'h2'
})

function startArgs(counter: number, head = 'h2'): PRDetailRecoveryStartArgs {
  return {
    clientEpoch: { scope: 'g1000.panel', counter },
    cacheKey: H2.cacheKey,
    identity: {
      sourceEpoch: 'renderer:a',
      repoId: 'repo-1',
      repoPath: '/repo',
      worktreeId: 'wt-1',
      branch: 'feature/test',
      currentHeadOid: head,
      executionHostId: null,
      provider: 'github',
      linkedPRNumber: null,
      fallbackPRNumber: 7,
      fallbackPRSource: 'hosted-review',
      selectionRevision: '|||||'
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function load() {
  const coordinator = await import('./pr-refresh-coordinator')
  const recovery = await import('./pr-detail-recovery-coordinator')
  const snapshot = async (ticketId: string) =>
    (await recovery.waitPRDetailRecovery(CALLER.callerKey, ticketId, -1))!
  const commit = async (ticketId: string) => {
    const prepared = await snapshot(ticketId)
    expect(prepared.phase).toBe('preparing')
    return recovery.commitPRDetailRecovery(CALLER.callerKey, {
      ticketId,
      prepareToken: prepared.preparation!.token,
      publicationGrantId: 'grant-1'
    })
  }
  return { ...coordinator, ...recovery, snapshot, commit }
}

function noPR(): PRRefreshOutcome {
  return { kind: 'no-pr', fetchedAt: START_AT }
}

describe('PR detail recovery tickets', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the current HEAD once after an unusable queued predecessor settles', async () => {
    const api = await load()
    const predecessor = deferred<PRRefreshOutcome>()
    getPRForBranchOutcomeMock
      .mockReturnValueOnce(predecessor.promise)
      .mockResolvedValueOnce({ kind: 'found', pr: makePR({ number: 8 }), fetchedAt: START_AT })
    api.enqueuePRRefresh(H1, 'active', 80, 1)
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    expect(started.phase).toBe('waiting-existing')
    expect(started.predecessors).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    predecessor.resolve(noPR())
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await api.snapshot(started.ticketId)).admitted).toBe(false)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await api.commit(started.ticketId)
    await vi.advanceTimersByTimeAsync(0)
    const settled = await api.snapshot(started.ticketId)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock.mock.calls[1][4]).toBe(7)
    expect(getPRForBranchOutcomeMock.mock.calls[1][5]).toMatchObject({ currentHeadOid: 'h2' })
    expect(settled.admitted).toBe(true)
    expect(settled.publicationGrantId).toBe('grant-1')
    expect(settled.terminal).toMatchObject({
      kind: 'settled',
      outcome: { kind: 'found', pr: { number: 8 } }
    })
  })

  it('keeps a ticket whose visible predecessor schedules its own follow-up', async () => {
    const api = await load()
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 7, state: 'merged' }),
      fetchedAt: START_AT
    })
    api.reportVisiblePRRefreshCandidates([H1], 1, 1)
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    expect(started.predecessors).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_000)
    const prepared = await api.snapshot(started.ticketId)
    expect(prepared.terminal).toBeUndefined()
    expect(prepared.phase).toBe('preparing')
  })

  it('closes an unadmitted ticket when new work for its alias registers', async () => {
    const api = await load()
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    await vi.advanceTimersByTimeAsync(0)
    expect((await api.snapshot(started.ticketId)).phase).toBe('preparing')
    api.enqueuePRRefresh(
      makeCandidate({ branch: 'other', cacheKey: '/repo::other' }),
      'active',
      80,
      1
    )
    expect((await api.snapshot(started.ticketId)).terminal).toBeUndefined()

    api.enqueuePRRefresh(H2, 'active', 80, 1)
    expect((await api.snapshot(started.ticketId)).terminal).toEqual({ kind: 'superseded' })
  })

  it('revokes publication when a direct read follows admission, without a second recovery read', async () => {
    const api = await load()
    const recoveryRead = deferred<PRRefreshOutcome>()
    getPRForBranchOutcomeMock
      .mockReturnValueOnce(recoveryRead.promise)
      .mockResolvedValueOnce(noPR())
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    await vi.advanceTimersByTimeAsync(0)
    await api.commit(started.ticketId)
    await vi.advanceTimersByTimeAsync(0)
    expect((await api.snapshot(started.ticketId)).admitted).toBe(true)

    await api.refreshPRNow(H2, 'manual')
    recoveryRead.resolve({ kind: 'found', pr: makePR({ number: 8 }), fetchedAt: START_AT })
    await vi.advanceTimersByTimeAsync(0)
    expect((await api.snapshot(started.ticketId)).terminal).toEqual({ kind: 'superseded' })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('expires an uncommitted preparation without reading', async () => {
    const api = await load()
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    await vi.advanceTimersByTimeAsync(0)
    expect((await api.snapshot(started.ticketId)).phase).toBe('preparing')
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await api.snapshot(started.ticketId)).terminal).toEqual({
      kind: 'not-admitted',
      reason: 'prepare-expired'
    })
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })

  it('times out a hung admitted read and keeps its slot from a successor ticket', async () => {
    const api = await load()
    getPRForBranchOutcomeMock.mockReturnValue(new Promise(() => {}))
    const first = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    await vi.advanceTimersByTimeAsync(0)
    await api.commit(first.ticketId)
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await api.snapshot(first.ticketId)).terminal).toEqual({ kind: 'timeout' })

    const second = api.startPRDetailRecovery(CALLER, startArgs(2), H2)
    expect(second.phase).toBe('waiting-existing')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('waits for a host rate gate and then reads once with the original hint', async () => {
    const api = await load()
    const resetAt = START_AT + 60_000
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: true, resetAt: resetAt / 1000 })
    getPRForBranchOutcomeMock.mockResolvedValue(noPR())
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    await vi.advanceTimersByTimeAsync(0)
    const paused = await api.snapshot(started.ticketId)
    expect(paused.phase).toBe('paused')
    expect(paused.notBefore).toBe(resetAt)
    // The panel's bounded waits renew the lease through a long finite gate.
    await vi.advanceTimersByTimeAsync(30_000)
    await api.snapshot(started.ticketId)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()

    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
    await vi.advanceTimersByTimeAsync(1_000)
    await api.commit(started.ticketId)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(getPRForBranchOutcomeMock.mock.calls[0][4]).toBe(7)
  })

  it('treats start and commit as idempotent and refuses reused or stale epochs', async () => {
    const api = await load()
    getPRForBranchOutcomeMock.mockResolvedValue(noPR())
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    expect(api.startPRDetailRecovery(CALLER, startArgs(1), H2).ticketId).toBe(started.ticketId)
    expect(api.startPRDetailRecovery(CALLER, startArgs(1, 'h3'), H2).terminal).toEqual({
      kind: 'not-admitted',
      reason: 'epoch-conflict'
    })
    await vi.advanceTimersByTimeAsync(0)
    const prepared = await api.snapshot(started.ticketId)
    const commitArgs = {
      ticketId: started.ticketId,
      prepareToken: prepared.preparation!.token,
      publicationGrantId: 'grant-1'
    }
    api.commitPRDetailRecovery(CALLER.callerKey, commitArgs)
    api.commitPRDetailRecovery(CALLER.callerKey, commitArgs)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(api.commitPRDetailRecovery('ipc:2', commitArgs)).toBeNull()

    expect(api.startPRDetailRecovery(CALLER, startArgs(2), H2).terminal).toBeUndefined()
    expect(api.startPRDetailRecovery(CALLER, startArgs(1), H2).terminal).toEqual({
      kind: 'expired'
    })
  })

  it('wakes promptly after a host-only direct predecessor settles, honouring its cooldown', async () => {
    const api = await load()
    const direct = deferred<PRRefreshOutcome>()
    getPRForBranchOutcomeMock.mockReturnValueOnce(direct.promise)
    const directRead = api.refreshPRNow(H1, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    expect(started.phase).toBe('waiting-existing')

    await vi.advanceTimersByTimeAsync(1_000)
    direct.resolve(noPR())
    await directRead
    await vi.advanceTimersByTimeAsync(5_000)
    // The direct read's cooldown is a future gate, not a reason to wait for the lease tick.
    expect((await api.snapshot(started.ticketId)).phase).toBe('paused')
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await api.snapshot(started.ticketId)).phase).toBe('preparing')
  })

  it('prepares as soon as a hosted direct predecessor settles', async () => {
    const api = await load()
    const hosted = deferred<PRRefreshOutcome>()
    const hostedRead = api.runHostedPRRead(H1, () => hosted.promise)
    const started = api.startPRDetailRecovery(CALLER, startArgs(1), H2)
    expect(started.phase).toBe('waiting-existing')
    hosted.resolve(noPR())
    await hostedRead
    await vi.advanceTimersByTimeAsync(0)
    expect((await api.snapshot(started.ticketId)).phase).toBe('preparing')
  })
})
