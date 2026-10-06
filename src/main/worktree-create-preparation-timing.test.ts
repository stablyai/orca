import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddWorktreeResult } from './git/worktree'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  prepare: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  listWorktreeGraph: vi.fn(),
  resolveBaseRef: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: vi.fn()
}))
vi.mock('./git/worktree-base-ref-probe', () => ({
  resolveLocalWorktreeBaseRef: mocks.resolveBaseRef
}))
vi.mock('./git/worktree-base-divergence', () => ({ measureRetargetDivergence: vi.fn() }))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: vi.fn(),
  getWorktreeMirrorDistro: vi.fn()
}))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRootAsync: vi.fn(),
  getWorktreePathSettings: vi.fn()
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate
} from './worktree-create-preparation'
import { startPreparation } from './worktree-create-preparation-pool'
import { createWorktreeCreateTimingRecorder } from './worktree-create-timing'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginWorktreeCreate
} from './worktree-create-concurrency'

const request = {
  repoPath: '/repo',
  workspaceRoot: '/workspace',
  worktreePath: '/workspace/feature',
  branch: 'feature',
  baseBranch: 'origin/main'
}

function prepare() {
  return startPreparation({
    repoPath: request.repoPath,
    workspaceRoot: request.workspaceRoot,
    baseBranch: request.baseBranch,
    canonicalBase: 'refs/remotes/origin/main',
    options: {}
  })
}

/** Lets the claim's own phase settle before the test clock moves on to the wait. */
function settleClaim(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.prepare.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.resolveBaseRef.mockReset()
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
  _resetWorktreeCreateConcurrencyForTests()
  vi.restoreAllMocks()
})

describe('prepared checkout create timing', () => {
  it('separates the remaining preparation wait from finalization', async () => {
    const checkoutStarted = Promise.withResolvers<void>()
    const checkout = Promise.withResolvers<void>()
    const finalizeStarted = Promise.withResolvers<void>()
    const finalize = Promise.withResolvers<AddWorktreeResult>()
    mocks.prepare.mockImplementation(() => {
      checkoutStarted.resolve()
      return checkout.promise
    })
    mocks.finalize.mockImplementation(() => {
      finalizeStarted.resolve()
      return finalize.promise
    })
    const preparation = prepare()
    await checkoutStarted.promise

    let now = 40
    const timing = createWorktreeCreateTimingRecorder(() => now)
    const create = timing.time('git_worktree_add', () =>
      consumePreparedWorktreeCreate({ ...request, timing })
    )
    await settleClaim()
    now = 150
    checkout.resolve()
    await finalizeStarted.promise
    now = 180
    finalize.resolve({})

    expect(await create).toMatchObject({ status: 'hit', retargeted: false, reset: 'none' })
    await preparation
    expect(timing.finish()).toEqual({
      totalDurationMs: 140,
      preparedCheckout: {
        status: 'hit',
        reset: 'none',
        origin: 'prefetch',
        buildMs: expect.any(Number),
        idleMs: 0
      },
      phases: [
        { phase: 'prepared_checkout_claim', startedAtMs: 0, durationMs: 0 },
        { phase: 'prepared_checkout_wait', startedAtMs: 0, durationMs: 110 },
        { phase: 'prepared_checkout_finalize', startedAtMs: 110, durationMs: 30 },
        { phase: 'git_worktree_add', startedAtMs: 0, durationMs: 140 }
      ]
    })
  })

  it('records the wait when preparation fails and the create must fall back', async () => {
    const checkoutStarted = Promise.withResolvers<void>()
    const checkout = Promise.withResolvers<void>()
    mocks.prepare.mockImplementation(() => {
      checkoutStarted.resolve()
      return checkout.promise
    })
    const preparation = Promise.allSettled([prepare()])
    await checkoutStarted.promise
    let now = 0
    const timing = createWorktreeCreateTimingRecorder(() => now)
    const create = consumePreparedWorktreeCreate({ ...request, timing })
    await settleClaim()
    now = 250
    checkout.reject(new Error('checkout failed'))

    expect(await create).toEqual({
      status: 'miss',
      reason: 'prepare_failed',
      rearm: expect.any(Function)
    })
    await preparation
    expect(timing.finish().phases).toEqual([
      { phase: 'prepared_checkout_claim', startedAtMs: 0, durationMs: 0 },
      { phase: 'prepared_checkout_wait', startedAtMs: 0, durationMs: 250 }
    ])
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('times the cleanup of a failed finalization apart from the finalization', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await prepare()
    let now = 0
    const timing = createWorktreeCreateTimingRecorder(() => now)
    mocks.finalize.mockImplementation(async () => {
      now = 80
      throw new Error('move failed')
    })
    mocks.discard.mockImplementation(async () => {
      now = 100
    })

    expect(await consumePreparedWorktreeCreate({ ...request, timing })).toEqual({
      status: 'miss',
      reason: 'finalize_failed',
      rearm: expect.any(Function)
    })
    expect(timing.finish().phases).toEqual([
      { phase: 'prepared_checkout_claim', startedAtMs: 0, durationMs: 0 },
      { phase: 'prepared_checkout_wait', startedAtMs: 0, durationMs: 0 },
      { phase: 'prepared_checkout_finalize', startedAtMs: 0, durationMs: 80 },
      { phase: 'prepared_checkout_discard', startedAtMs: 80, durationMs: 20 }
    ])
  })

  it('reports only the claim, and the miss, when no checkout was armed', async () => {
    const timing = createWorktreeCreateTimingRecorder(() => 0)
    expect(await consumePreparedWorktreeCreate({ ...request, timing })).toEqual({
      status: 'miss',
      reason: 'none_armed'
    })
    expect(timing.finish()).toMatchObject({
      phases: [{ phase: 'prepared_checkout_claim', startedAtMs: 0, durationMs: 0 }],
      preparedCheckout: { status: 'miss', reason: 'none_armed' }
    })
  })

  it('times a miss probe as the claim, not as the plain add after it', async () => {
    await startPreparation({
      repoPath: request.repoPath,
      workspaceRoot: request.workspaceRoot,
      baseBranch: 'origin/release',
      canonicalBase: 'refs/remotes/origin/release',
      options: {}
    })
    let now = 0
    const timing = createWorktreeCreateTimingRecorder(() => now)
    mocks.resolveBaseRef.mockImplementation(async () => {
      now = 400
      return 'refs/remotes/origin/main'
    })

    const attempt = await timing.time('git_worktree_add', async () => {
      const result = await consumePreparedWorktreeCreate({ ...request, timing })
      now = 500
      return result
    })

    expect(attempt).toMatchObject({ status: 'miss', reason: 'base_mismatch' })
    expect(timing.finish().phases).toEqual([
      { phase: 'prepared_checkout_claim', startedAtMs: 0, durationMs: 400 },
      { phase: 'git_worktree_add', startedAtMs: 0, durationMs: 500 }
    ])
  })

  it('reports the reset a hit needed and who armed it', async () => {
    await startPreparation(
      {
        repoPath: request.repoPath,
        workspaceRoot: request.workspaceRoot,
        baseBranch: request.baseBranch,
        canonicalBase: 'refs/remotes/origin/main',
        options: {}
      },
      'automatic'
    )
    mocks.finalize.mockResolvedValue({ preparedHeadReset: true })
    const timing = createWorktreeCreateTimingRecorder(() => 0)

    const attempt = await consumePreparedWorktreeCreate({ ...request, timing })

    expect(attempt).toMatchObject({ status: 'hit', reset: 'base_moved', origin: 'rearm' })
    expect(attempt.status === 'hit' && attempt.result).toEqual({})
    expect(timing.finish().preparedCheckout).toMatchObject({
      status: 'hit',
      reset: 'base_moved',
      origin: 'rearm'
    })
  })

  it('reports a re-arm the new-worktree UI then asked for as well', async () => {
    const args = {
      repoPath: request.repoPath,
      workspaceRoot: request.workspaceRoot,
      baseBranch: request.baseBranch,
      canonicalBase: 'refs/remotes/origin/main',
      options: {}
    }
    await startPreparation(args, 'automatic')
    await startPreparation(args, 'explicit')
    expect(mocks.prepare).toHaveBeenCalledOnce()

    const attempt = await consumePreparedWorktreeCreate({ ...request })

    expect(attempt).toMatchObject({ status: 'hit', origin: 'rearm_then_prefetch' })
  })

  it('reports how long the build took and how long it sat ready before the claim', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const checkout = Promise.withResolvers<void>()
    mocks.prepare.mockReturnValue(checkout.promise)
    const preparation = prepare()
    now = 4_000
    checkout.resolve()
    await preparation
    now = 9_000

    const attempt = await consumePreparedWorktreeCreate({ ...request })

    expect(attempt).toMatchObject({ status: 'hit', buildMs: 3_000, idleMs: 5_000 })
  })

  it('reports no idle time when the create waited for the build', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const checkoutStarted = Promise.withResolvers<void>()
    const checkout = Promise.withResolvers<void>()
    mocks.prepare.mockImplementation(() => {
      checkoutStarted.resolve()
      return checkout.promise
    })
    const preparation = prepare()
    await checkoutStarted.promise
    now = 2_000
    const create = consumePreparedWorktreeCreate({ ...request })
    await settleClaim()
    now = 6_000
    checkout.resolve()
    await preparation

    expect(await create).toMatchObject({ status: 'hit', buildMs: 5_000, idleMs: 0 })
  })

  it('counts a building prepared checkout against other creates but not the one that used it', async () => {
    const checkoutStarted = Promise.withResolvers<void>()
    const checkout = Promise.withResolvers<void>()
    mocks.prepare.mockImplementation(() => {
      checkoutStarted.resolve()
      return checkout.promise
    })
    const bystander = beginWorktreeCreate()
    const preparation = prepare()
    await checkoutStarted.promise
    const inFlight = beginWorktreeCreate()
    const timing = createWorktreeCreateTimingRecorder(undefined, inFlight)

    const create = consumePreparedWorktreeCreate({ ...request, timing })
    await settleClaim()
    checkout.resolve()
    await preparation

    expect(await create).toMatchObject({ status: 'hit', origin: 'prefetch' })
    expect(inFlight.end().preparations).toBe(0)
    expect(bystander.end().preparations).toBe(1)
  })
})
