import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import type {
  WslMoveProgressEvent,
  WslMoveResult
} from '../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveDriverDeps } from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import { runTrackedWslMove, wslMoveResetReason } from './wsl-move-telemetry'

const track = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ track }))

beforeEach(() => {
  track.mockReset()
})

type Fake = { clock: { ms: number }; deps: WslMoveDriverDeps }

function fakeDeps(): Fake {
  const clock = { ms: 0 }
  const partial: Pick<WslMoveDriverDeps, 'now' | 'progress'> = {
    now: () => new Date(clock.ms),
    progress: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runTrackedWslMove reads only `now` and `progress`, both provided.
  return { clock, deps: partial as WslMoveDriverDeps }
}

async function tracked(
  result: WslMoveResult,
  progress: WslMoveProgressEvent[] = [],
  durationMs = 1_000
): Promise<unknown[]> {
  const fake = fakeDeps()
  const returned = await runTrackedWslMove(fake.deps, async (wrapped) => {
    progress.forEach((event) => wrapped.progress(event))
    fake.clock.ms += durationMs
    return result
  })
  expect(returned).toBe(result)
  return track.mock.calls.map(([name, props]) => {
    expect(name).toBe('wsl_move')
    return eventSchemas.wsl_move.parse(props)
  })
}

describe('WSL move telemetry', () => {
  it('reports the start, then a finish with its size and duration buckets', async () => {
    const events = await tracked(
      { outcome: 'moved', migrationId: 'm-1', phase: 'client-rewritten', reloadRequired: true },
      [
        {
          distro: 'Ubuntu',
          step: 'copying',
          phase: 'destination-staged',
          bytesTotal: 4 * 1024 * 1024
        }
      ],
      20_000
    )
    expect(events).toEqual([
      expect.objectContaining({ outcome: 'started' }),
      {
        outcome: 'finished',
        refusal: 'none',
        phase: 'destination_committed',
        reset_reason: 'none',
        duration_bucket: '15s_60s',
        bytes_bucket: '1mb_10mb'
      }
    ])
  })

  it('reports a reset with the phase it reached and a reason code, never the detail', async () => {
    const events = await tracked(
      {
        outcome: 'reset',
        migrationId: 'move-id-1',
        detail: 'orcad_migration_repository_path_conflict:/home/secret-user/app'
      },
      [{ distro: 'MyDistro', step: 'copying', phase: 'destination-staged' }]
    )
    expect(events[1]).toMatchObject({
      outcome: 'reset',
      phase: 'destination_staged',
      reset_reason: 'repository_path_conflict'
    })
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/secret-user|MyDistro|move-id-1/)
  })

  it('reports a refusal by its code, and a lost distro as such', async () => {
    const events = await tracked({
      outcome: 'refused',
      code: 'wsl_move_host_unavailable',
      detail: 'distro_unregistered'
    })
    expect(events[1]).toMatchObject({
      outcome: 'refused',
      refusal: 'host_unavailable',
      reset_reason: 'distro_unregistered'
    })
  })

  it('reports why a pause refusal after a reset happened', async () => {
    const events = await tracked({
      outcome: 'refused',
      code: 'wsl_move_pause_failed',
      detail: 'terminals-started-after-pause'
    })
    expect(events[1]).toMatchObject({
      refusal: 'pause_failed',
      reset_reason: 'terminals_started'
    })
  })

  it('reports an outcome even when the run throws', async () => {
    await expect(
      runTrackedWslMove(fakeDeps().deps, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(track.mock.calls.map(([, props]) => props.outcome)).toEqual(['started', 'reset'])
  })

  it('reports a move left waiting for its host', async () => {
    const events = await tracked(
      { outcome: 'waiting-for-host', migrationId: 'm-1', detail: 'x; destination_unreachable' },
      [{ distro: 'Ubuntu', step: 'switching', phase: 'blobs-transferred' }]
    )
    expect(events[1]).toMatchObject({
      outcome: 'waiting_for_host',
      phase: 'blobs_transferred',
      reset_reason: 'host_unreachable'
    })
  })

  it('still moves when telemetry throws', async () => {
    track.mockImplementation(() => {
      throw new Error('telemetry down')
    })
    const result: WslMoveResult = { outcome: 'refused', code: 'wsl_move_cancelled' }
    expect(await runTrackedWslMove(fakeDeps().deps, async () => result)).toBe(result)
  })

  it.each([
    ['orcad_migration_staged_claim_conflict:repository:repo-1', 'staged_claim_conflict'],
    ['terminals-started-after-pause', 'terminals_started'],
    ['exit-unverifiable: census_unavailable', 'exit_unverifiable'],
    ['wsl_move_commit_not_committed:absent', 'commit_rejected'],
    ['database connection is closed', 'other'],
    ['something new', 'other']
  ])('narrows %s to %s', (detail, reason) => {
    expect(wslMoveResetReason(detail)).toBe(reason)
  })
})
