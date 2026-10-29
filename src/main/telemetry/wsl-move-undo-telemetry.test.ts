import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import type { WslMoveUseLocallyResult } from '../../shared/wsl-move/wsl-moved-project'
import { runTrackedWslMoveUndo, wslMoveUndoOutcome } from './wsl-move-undo-telemetry'

const track = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ track }))

beforeEach(() => {
  track.mockReset()
})

const released: WslMoveUseLocallyResult = {
  released: true,
  distro: 'Ubuntu',
  repoIds: ['repo-1'],
  folderWorkspaceIds: []
}

async function tracked(result: WslMoveUseLocallyResult, durationMs = 1_000): Promise<unknown> {
  let ms = 0
  const returned = await runTrackedWslMoveUndo(
    () => ms,
    async () => {
      ms += durationMs
      return result
    }
  )
  expect(returned).toBe(result)
  expect(track).toHaveBeenCalledTimes(1)
  const [name, props] = track.mock.calls[0] ?? []
  expect(name).toBe('wsl_move_undo')
  expect(eventSchemas.wsl_move_undo.safeParse(props).success).toBe(true)
  return props
}

describe('wsl_move_undo telemetry', () => {
  it('reports a released project with its duration bucket and nothing it named', async () => {
    const props = await tracked(released, 20_000)
    expect(props).toEqual({ outcome: 'released', duration_bucket: '15s_60s' })
    expect(JSON.stringify(props)).not.toMatch(/Ubuntu|repo-1/u)
  })

  it.each([
    ['not-moved', 'not_moved'],
    ['superseded', 'superseded'],
    ['move-running', 'move_running'],
    ['host-still-running', 'host_still_running'],
    ['host-unreachable', 'host_unreachable'],
    ['unsaved-files', 'unsaved_files'],
    ['failed', 'failed']
  ] as const)('reports a %s refusal as %s', async (reason, outcome) => {
    const props = await tracked({ released: false, reason, detail: 'C:\\Users\\someone' })
    expect(props).toEqual({ outcome, duration_bucket: 'lt_5s' })
  })

  it('reports an undo that threw as threw, apart from a failed refusal, and rethrows it', async () => {
    const error = new Error('boom')
    await expect(
      runTrackedWslMoveUndo(
        () => 0,
        async () => {
          throw error
        }
      )
    ).rejects.toBe(error)
    expect(track).toHaveBeenCalledWith('wsl_move_undo', {
      outcome: 'threw',
      duration_bucket: 'lt_5s'
    })
  })

  it('buckets a clock that stepped back as the shortest duration', async () => {
    let ms = 10_000
    await expect(
      runTrackedWslMoveUndo(
        () => ms,
        async () => {
          ms -= 5_000
          throw new Error('boom')
        }
      )
    ).rejects.toThrow('boom')
    expect(track).toHaveBeenCalledWith('wsl_move_undo', {
      outcome: 'threw',
      duration_bucket: 'lt_5s'
    })
  })

  it('never lets telemetry cost the undo', async () => {
    track.mockImplementation(() => {
      throw new Error('telemetry down')
    })
    await expect(
      runTrackedWslMoveUndo(
        () => 0,
        async () => released
      )
    ).resolves.toBe(released)
  })

  it('maps an unknown reason to other', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a reason a newer main could return.
    const unknown = {
      released: false,
      reason: 'something-new'
    } as unknown as WslMoveUseLocallyResult
    expect(wslMoveUndoOutcome(unknown)).toBe('other')
  })
})
