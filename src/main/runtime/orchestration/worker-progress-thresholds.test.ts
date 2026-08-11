import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKER_PROGRESS_THRESHOLDS,
  resolveWorkerProgressThresholds,
  WEDGED_WORKER_ENV_KEYS
} from './worker-progress-thresholds'

describe('resolveWorkerProgressThresholds', () => {
  it('uses the documented defaults when nothing is configured', () => {
    expect(resolveWorkerProgressThresholds({})).toEqual(DEFAULT_WORKER_PROGRESS_THRESHOLDS)
  })

  it('reads each threshold from the environment', () => {
    expect(
      resolveWorkerProgressThresholds({
        [WEDGED_WORKER_ENV_KEYS.wedgedAfterMs]: '600000',
        [WEDGED_WORKER_ENV_KEYS.reEscalateAfterMs]: '1200000',
        [WEDGED_WORKER_ENV_KEYS.scanIntervalMs]: '30000'
      })
    ).toEqual({
      wedgedAfterMs: 600_000,
      reEscalateAfterMs: 1_200_000,
      scanIntervalMs: 30_000,
      enabled: true
    })
  })

  it('turns detection off on request', () => {
    expect(
      resolveWorkerProgressThresholds({ [WEDGED_WORKER_ENV_KEYS.enabled]: 'off' })
    ).toMatchObject({ enabled: false })
    expect(
      resolveWorkerProgressThresholds({ [WEDGED_WORKER_ENV_KEYS.enabled]: '0' })
    ).toMatchObject({ enabled: false })
    expect(
      resolveWorkerProgressThresholds({ [WEDGED_WORKER_ENV_KEYS.enabled]: 'true' })
    ).toMatchObject({ enabled: true })
  })

  it('clamps values that would turn the detector into a spammer', () => {
    expect(
      resolveWorkerProgressThresholds({
        [WEDGED_WORKER_ENV_KEYS.wedgedAfterMs]: '1000',
        [WEDGED_WORKER_ENV_KEYS.reEscalateAfterMs]: '1',
        [WEDGED_WORKER_ENV_KEYS.scanIntervalMs]: '1'
      })
    ).toEqual({
      wedgedAfterMs: 60_000,
      reEscalateAfterMs: 60_000,
      scanIntervalMs: 5_000,
      enabled: true
    })
  })

  it('ignores unparseable values', () => {
    expect(
      resolveWorkerProgressThresholds({
        [WEDGED_WORKER_ENV_KEYS.wedgedAfterMs]: 'soon',
        [WEDGED_WORKER_ENV_KEYS.scanIntervalMs]: '-5',
        [WEDGED_WORKER_ENV_KEYS.enabled]: 'maybe'
      })
    ).toEqual(DEFAULT_WORKER_PROGRESS_THRESHOLDS)
  })

  it('never scans less often than the wedge threshold', () => {
    expect(
      resolveWorkerProgressThresholds({
        [WEDGED_WORKER_ENV_KEYS.wedgedAfterMs]: '90000',
        [WEDGED_WORKER_ENV_KEYS.scanIntervalMs]: '600000'
      })
    ).toMatchObject({ wedgedAfterMs: 90_000, scanIntervalMs: 90_000 })
  })
})
