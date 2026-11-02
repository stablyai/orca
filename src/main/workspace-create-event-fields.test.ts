import { describe, expect, it } from 'vitest'
import { eventSchemas } from '../shared/telemetry-event-registry'
import { createWorktreeCreateTimingRecorder } from './worktree-create-timing'
import {
  bucketRepoFileCount,
  bucketWorktreeCount,
  workspaceCreateFailureFields,
  workspaceCreateTimingFields
} from './workspace-create-event-fields'

const quiet = { otherCreates: 0, preparations: 0 }

describe('workspaceCreateTimingFields', () => {
  it('maps a local create with a prepared-checkout hit', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 1_000.4,
        phases: [
          { phase: 'refresh_base_ref', startedAtMs: 0, durationMs: 200.6 },
          { phase: 'git_worktree_add', startedAtMs: 200, durationMs: 500 },
          { phase: 'prepared_checkout_claim', startedAtMs: 200, durationMs: 4 },
          { phase: 'prepared_checkout_wait', startedAtMs: 204, durationMs: 300 },
          { phase: 'list_created_worktree', startedAtMs: 700, durationMs: 100 }
        ],
        preparedCheckout: {
          status: 'hit',
          reset: 'base_moved',
          origin: 'rearm',
          buildMs: 30_000.4,
          idleMs: 2_500
        },
        executionHost: 'local',
        worktreeCount: 812
      },
      {
        entryPoint: 'runtime',
        concurrency: { otherCreates: 1, preparations: 2 },
        repoFacts: { postCheckoutHook: 'absent', indexEntryCount: 42_000 }
      }
    )

    expect(fields).toEqual({
      total_ms: 1_000,
      unattributed_ms: 200,
      refresh_base_ref_ms: 201,
      git_worktree_add_ms: 500,
      prepared_checkout_claim_ms: 4,
      prepared_checkout_wait_ms: 300,
      list_created_worktree_ms: 100,
      prepared_checkout: 'hit',
      prepared_checkout_reset: 'base_moved',
      prepared_checkout_origin: 'rearm',
      prepared_checkout_build_ms: 30_000,
      prepared_checkout_idle_ms: 2_500,
      create_entry_point: 'runtime',
      execution_host: 'local',
      worktree_count_bucket: '301-1000',
      concurrent_creates: 1,
      concurrent_preparations: 2,
      repo_file_count_bucket: '10k-100k',
      post_checkout_hook: 'absent'
    })
    expect(
      eventSchemas.workspace_created.safeParse({
        source: 'sidebar',
        from_existing_branch: false,
        ...fields
      }).success
    ).toBe(true)
  })

  it('maps a miss with its reason and omits what the create did not learn', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 50,
        phases: [],
        preparedCheckout: { status: 'miss', reason: 'none_armed' }
      },
      { entryPoint: 'app', concurrency: quiet }
    )

    expect(fields).toEqual({
      total_ms: 50,
      unattributed_ms: 50,
      prepared_checkout: 'miss',
      prepared_checkout_miss_reason: 'none_armed',
      create_entry_point: 'app',
      concurrent_creates: 0,
      concurrent_preparations: 0
    })
  })

  it('sends the hook but no file count when the repo has no usable index', () => {
    const fields = workspaceCreateTimingFields(
      { totalDurationMs: 1, phases: [] },
      { entryPoint: 'app', concurrency: quiet, repoFacts: { postCheckoutHook: 'unknown' } }
    )
    expect(fields.post_checkout_hook).toBe('unknown')
    expect(fields).not.toHaveProperty('repo_file_count_bucket')
  })

  it('takes the worktree count from the repo read when the create did not list worktrees', () => {
    const fields = workspaceCreateTimingFields(
      { totalDurationMs: 1, phases: [] },
      {
        entryPoint: 'app',
        concurrency: quiet,
        repoFacts: { postCheckoutHook: 'absent', worktreeCount: 7 }
      }
    )
    expect(fields.worktree_count_bucket).toBe('6-20')
  })

  it('sums a repeated phase and drops names outside the closed vocabulary', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 100,
        phases: [
          { phase: 'refresh_base_ref', startedAtMs: 0, durationMs: 10 },
          { phase: 'refresh_base_ref', startedAtMs: 10, durationMs: 15 },
          { phase: '/Users/alice/repo', startedAtMs: 25, durationMs: 5 }
        ]
      },
      { entryPoint: 'app', concurrency: quiet }
    )

    expect(fields.refresh_base_ref_ms).toBe(25)
    expect(Object.keys(fields).some((key) => key.includes('alice'))).toBe(false)
  })
})

describe('workspaceCreateFailureFields', () => {
  it('names the failing phase and the elapsed time', async () => {
    let now = 0
    const recorder = createWorktreeCreateTimingRecorder(() => now)
    recorder.recordExecutionHost('ssh')
    const error = await recorder
      .time('git_worktree_add', async () => {
        now = 4_200
        throw new Error('fatal: could not create work tree dir /Users/alice/x')
      })
      .catch((caught: unknown) => caught)

    const fields = workspaceCreateFailureFields(recorder, {
      entryPoint: 'app',
      concurrency: { otherCreates: 3, preparations: 1 },
      error
    })

    expect(fields).toEqual({
      failed_phase: 'git_worktree_add',
      total_ms: 4_200,
      create_entry_point: 'app',
      execution_host: 'ssh',
      concurrent_creates: 3,
      concurrent_preparations: 1
    })
    expect(
      eventSchemas.workspace_create_failed.safeParse({
        source: 'sidebar',
        error_class: 'git_failed',
        ...fields
      }).success
    ).toBe(true)
  })

  it('carries the prepared-checkout outcome and wait of a create that failed after it', async () => {
    let now = 0
    const recorder = createWorktreeCreateTimingRecorder(() => now)
    recorder.recordExecutionHost('local')
    await recorder.time('prepared_checkout_wait', async () => {
      now = 200_400
    })
    recorder.recordPreparedCheckout({ status: 'miss', reason: 'finalize_failed' })
    const error = await recorder
      .time('git_worktree_add', async () => {
        throw new Error('fatal: a branch named feature already exists')
      })
      .catch((caught: unknown) => caught)

    const fields = workspaceCreateFailureFields(recorder, {
      entryPoint: 'runtime',
      concurrency: quiet,
      error
    })

    expect(fields).toMatchObject({
      failed_phase: 'git_worktree_add',
      prepared_checkout: 'miss',
      prepared_checkout_miss_reason: 'finalize_failed',
      prepared_checkout_wait_ms: 200_400,
      create_entry_point: 'runtime'
    })
    expect(
      eventSchemas.workspace_create_failed.safeParse({
        source: 'unknown',
        error_class: 'git_failed',
        ...fields
      }).success
    ).toBe(true)
  })

  it('reports untimed when the create failed outside every phase', () => {
    const recorder = createWorktreeCreateTimingRecorder(() => 0)
    expect(
      workspaceCreateFailureFields(recorder, {
        entryPoint: 'app',
        concurrency: quiet,
        error: new Error('x')
      }).failed_phase
    ).toBe('untimed')
  })
})

describe('bucketWorktreeCount', () => {
  it.each([
    [0, '1'],
    [1, '1'],
    [2, '2-5'],
    [5, '2-5'],
    [6, '6-20'],
    [21, '21-100'],
    [101, '101-300'],
    [301, '301-1000'],
    [1000, '301-1000'],
    [1001, '1001+']
  ] as const)('%i worktrees -> %s', (count, bucket) => {
    expect(bucketWorktreeCount(count)).toBe(bucket)
  })
})

describe('bucketRepoFileCount', () => {
  it.each([
    [0, '<1k'],
    [999, '<1k'],
    [1_000, '1k-10k'],
    [10_000, '10k-100k'],
    [100_000, '100k-500k'],
    [500_000, '500k+']
  ] as const)('%i files -> %s', (count, bucket) => {
    expect(bucketRepoFileCount(count)).toBe(bucket)
  })
})
