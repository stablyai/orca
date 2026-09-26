import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddWorktreeResult } from './git/worktree'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  prepare: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  listWorktreeGraph: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: vi.fn()
}))
vi.mock('./git/worktree-base-ref-probe', () => ({ resolveLocalWorktreeBaseRef: vi.fn() }))
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

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.prepare.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
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
    now = 150
    checkout.resolve()
    await finalizeStarted.promise
    now = 180
    finalize.resolve({})

    expect(await create).toMatchObject({ status: 'hit', retargeted: false })
    await preparation
    expect(timing.finish()).toEqual({
      totalDurationMs: 140,
      phases: [
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
    now = 250
    checkout.reject(new Error('checkout failed'))

    expect(await create).toEqual({
      status: 'miss',
      reason: 'prepare_failed',
      rearm: expect.any(Function)
    })
    await preparation
    expect(timing.finish().phases).toEqual([
      { phase: 'prepared_checkout_wait', startedAtMs: 0, durationMs: 250 }
    ])
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('records a failed finalization before its fallback cleanup', async () => {
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
      { phase: 'prepared_checkout_wait', startedAtMs: 0, durationMs: 0 },
      { phase: 'prepared_checkout_finalize', startedAtMs: 0, durationMs: 80 }
    ])
  })

  it('does not report a preparation wait when no checkout was armed', async () => {
    const timing = createWorktreeCreateTimingRecorder(() => 0)
    expect(await consumePreparedWorktreeCreate({ ...request, timing })).toEqual({
      status: 'miss',
      reason: 'none_armed'
    })
    expect(timing.finish().phases).toEqual([])
  })
})
