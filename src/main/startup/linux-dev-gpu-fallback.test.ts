import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why hoisted: the vi.mock factory below cannot close over top-level lets.
const harness = vi.hoisted(() => {
  const goneListeners: ((_event: unknown, details: { type?: string; reason: string }) => void)[] =
    []
  return {
    goneListeners,
    appMock: {
      exit: vi.fn(),
      on: vi.fn(
        (
          channel: string,
          listener: (_event: unknown, details: { type?: string; reason: string }) => void
        ) => {
          if (channel === 'child-process-gone') {
            goneListeners.push(listener)
          }
        }
      )
    }
  }
})

vi.mock('electron', () => ({ app: harness.appMock }))

import {
  installLinuxDevGpuFailureWatch,
  isLinuxDevGpuFallbackSession
} from './linux-dev-gpu-fallback'
import { GpuCrashFallbackTracker } from '../crash-reporting/gpu-crash-fallback-decision'
import {
  GPU_FALLBACK_SCHEME_VERSION,
  type LinuxGpuFallbackEnvironment
} from './gpu-fallback-marker'

function emitChildGone(details: { type?: string; reason: string }): void {
  for (const listener of harness.goneListeners) {
    listener(undefined, details)
  }
}

describe('isLinuxDevGpuFallbackSession', () => {
  it('restricts the watcher to Linux dev sessions', () => {
    expect(
      isLinuxDevGpuFallbackSession({ platform: 'linux', isDev: true, isServeMode: false })
    ).toBe(true)
    // packaged Linux must never engage
    expect(
      isLinuxDevGpuFallbackSession({ platform: 'linux', isDev: false, isServeMode: false })
    ).toBe(false)
    expect(
      isLinuxDevGpuFallbackSession({ platform: 'linux', isDev: true, isServeMode: true })
    ).toBe(false)
    expect(
      isLinuxDevGpuFallbackSession({ platform: 'win32', isDev: true, isServeMode: false })
    ).toBe(false)
  })
})

describe('installLinuxDevGpuFailureWatch', () => {
  let userDataPath: string
  let markerEnvironment: LinuxGpuFallbackEnvironment | null
  let log: (message: string) => void

  function register(): void {
    installLinuxDevGpuFailureWatch({
      tracker: new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 }),
      resolveMarkerEnvironment: () => markerEnvironment,
      resolveUserDataPath: () => userDataPath,
      log
    })
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-linux-gpu-watch-test-'))
    markerEnvironment = { appVersion: '1.2.3', electronVersion: '43.1.0', platform: 'linux' }
    log = vi.fn((message: string) => {
      void message
    })
    harness.goneListeners.length = 0
    harness.appMock.exit.mockReset()
    harness.appMock.on.mockClear()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers a pre-window child-process-gone listener', () => {
    register()
    expect(harness.appMock.on).toHaveBeenCalledWith('child-process-gone', expect.any(Function))
  })

  it('persists the build-scoped marker and exits once launch failures cluster', () => {
    register()
    emitChildGone({ type: 'GPU', reason: 'launch-failed' })
    emitChildGone({ type: 'GPU', reason: 'crashed' })
    emitChildGone({ type: 'GPU', reason: 'abnormal-exit' })

    expect(harness.appMock.exit).toHaveBeenCalledWith(1)
    const marker = JSON.parse(readFileSync(join(userDataPath, 'gpu-fallback.json'), 'utf-8')) as {
      schemeVersion: number
      platform: string
      appVersion: string
      crashesInWindow: number
    }
    expect(marker).toMatchObject({
      schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
      platform: 'linux',
      appVersion: '1.2.3',
      crashesInWindow: 3
    })
  })

  it('ignores scattered GPU failures and non-crash-shaped reasons', () => {
    register()
    emitChildGone({ type: 'GPU', reason: 'launch-failed' })
    emitChildGone({ type: 'GPU', reason: 'clean-exit' })
    emitChildGone({ type: 'GPU', reason: 'killed' })

    expect(harness.appMock.exit).not.toHaveBeenCalled()
    expect(() => readFileSync(join(userDataPath, 'gpu-fallback.json'), 'utf-8')).toThrowError()
  })

  it('counts only GPU children', () => {
    register()
    for (let i = 0; i < 5; i += 1) {
      emitChildGone({ type: 'renderer', reason: 'launch-failed' })
    }
    expect(harness.appMock.exit).not.toHaveBeenCalled()
  })

  it('skips engagement when the build environment cannot be identified', () => {
    // Why: a null environment means "cannot identify this build"; engaging would persist an
    // unattributable marker, so stay on hardware acceleration instead.
    markerEnvironment = null
    register()
    for (let i = 0; i < 4; i += 1) {
      emitChildGone({ type: 'GPU', reason: 'launch-failed' })
    }
    expect(harness.appMock.exit).not.toHaveBeenCalled()
    expect(() => readFileSync(join(userDataPath, 'gpu-fallback.json'), 'utf-8')).toThrowError()
  })
})
