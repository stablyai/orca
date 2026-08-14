import { describe, expect, it } from 'vitest'
import {
  SERVE_ALREADY_RUNNING_EXIT_CODE,
  shouldSpawnForegroundServe
} from './foreground-serve-policy'

describe('shouldSpawnForegroundServe', () => {
  it('spawns when nothing is running', () => {
    expect(
      shouldSpawnForegroundServe({
        app: { running: false },
        runtime: { reachable: false }
      })
    ).toBe(true)
  })

  it('does not spawn when the runtime is already reachable', () => {
    expect(
      shouldSpawnForegroundServe({
        app: { running: true },
        runtime: { reachable: true }
      })
    ).toBe(false)
  })

  it('does not spawn when a live app pid is still running but not yet reachable', () => {
    expect(
      shouldSpawnForegroundServe({
        app: { running: true },
        runtime: { reachable: false }
      })
    ).toBe(false)
  })
})

describe('SERVE_ALREADY_RUNNING_EXIT_CODE', () => {
  it('matches the single-instance already-running contract', () => {
    expect(SERVE_ALREADY_RUNNING_EXIT_CODE).toBe(3)
  })
})
