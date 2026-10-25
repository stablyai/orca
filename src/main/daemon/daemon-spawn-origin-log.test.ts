import { afterEach, expect, it, vi } from 'vitest'
import {
  logWslSpawnOrigin,
  probeWslColdRestoreScreen,
  rememberSpawnCaller
} from './daemon-spawn-origin-log'

afterEach(() => {
  vi.restoreAllMocks()
})

function nested(depth: number, sessionId: string): void {
  if (depth === 0) {
    rememberSpawnCaller(sessionId)
    return
  }
  nested(depth - 1, sessionId)
}

it('logs caller frames beyond the default stack limit and restores the limit', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const limit = Error.stackTraceLimit
  nested(20, 'wsl-session')
  expect(Error.stackTraceLimit).toBe(limit)

  logWslSpawnOrigin({
    sessionId: 'wsl-session',
    wslDistro: 'Ubuntu',
    isNew: true,
    attachOnly: false,
    spawnIntent: undefined,
    coldRestore: true
  })

  const logged: { caller: string[] } = JSON.parse(String(info.mock.calls[0]?.[1]))
  expect(logged.caller.length).toBeGreaterThan(20)
  expect(logged.caller.filter((frame) => frame.includes('nested')).length).toBeGreaterThan(10)
})

it('logs the daemon screen a WSL cold restore left, after the first prompt', async () => {
  vi.useFakeTimers()
  try {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    probeWslColdRestoreScreen('wsl-session', async () => ({
      snapshotAnsi: 'old$ new$ ',
      scrollbackLines: 0,
      rows: 58,
      cols: 119
    }))
    expect(info).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(info).toHaveBeenCalledWith('[wsl-cold-restore-screen]', expect.any(String))
    const logged: { scrollbackLines: number; tail: string } = JSON.parse(
      String(info.mock.calls[0]?.[1])
    )
    expect(logged).toMatchObject({ scrollbackLines: 0, tail: JSON.stringify('old$ new$ ') })
  } finally {
    vi.useRealTimers()
  }
})
