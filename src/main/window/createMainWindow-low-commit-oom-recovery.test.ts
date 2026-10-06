import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)
vi.mock('../browser/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  resetPreGoneSystemMemorySamplingForTest,
  samplePreGoneSystemMemory
} from '../crash-reporting/pre-gone-host-memory'
import { setSystemMemoryInfoReaderForTest } from '../crash-reporting/system-memory-details'
import { setSwapVolumeFreeSpaceReaderForTest } from '../crash-reporting/swap-volume-free-space'
import {
  createRendererRecoveryWindowHarness,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

// Launch 13084 (Scan-31 1790683596/1790684449/1790684587): the second reload OOMed 3.458 s after the first.
const OOM_AT = [
  '2026-09-29T12:06:19.869Z',
  '2026-09-29T12:20:37.207Z',
  '2026-09-29T12:20:40.665Z',
  '2026-09-29T12:22:59.975Z'
].map((iso) => Date.parse(iso))
// Commit at the two OOMs of launch 22912 (Scan-30 1790622432/1790622459): 744 MB, then 60 MB of a 130 GB limit.
const HEALTHY_FIRST_OOM_COMMIT_MB = 744
const EXHAUSTED_COMMIT_MB = 60
const RECOVERED_COMMIT_MB = 2_029

const OOM: Electron.RenderProcessGoneDetails = { reason: 'oom', exitCode: -536870904 }

function hostWithAvailableCommit(swapFreeMB: number): void {
  setSystemMemoryInfoReaderForTest(() => ({
    total: 32_000 * 1024,
    free: 976 * 1024,
    swapTotal: 130_000 * 1024,
    swapFree: swapFreeMB * 1024
  }))
  void samplePreGoneSystemMemory(Date.now())
}

async function runOomSequence(
  platform: NodeJS.Platform,
  commitAtEachOomMB: readonly (number | null)[],
  goneTimeCommitMB?: number
): Promise<{ reloads: number; onRendererRecoveryExhausted: ReturnType<typeof vi.fn> }> {
  const onRendererRecoveryExhausted = vi.fn()
  const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()
  createMainWindow(null, { onRendererRecoveryExhausted })
  for (const [index, goneAt] of OOM_AT.entries()) {
    const commitMB = commitAtEachOomMB[index]
    // null: no sampler tick since the previous OOM.
    if (commitMB !== null) {
      vi.setSystemTime(goneAt - 2_000)
      withPlatform(platform, () => hostWithAvailableCommit(commitMB))
    }
    vi.setSystemTime(goneAt)
    if (goneTimeCommitMB !== undefined) {
      // Only the host changes; no sampler tick commits it.
      setSystemMemoryInfoReaderForTest(() => ({ swapFree: goneTimeCommitMB * 1024 }))
    }
    withPlatform(platform, () => windowHandlers['render-process-gone']?.({}, OOM))
    await vi.advanceTimersByTimeAsync(250)
  }
  // Minus the initial load.
  return {
    reloads: browserWindowInstance.loadFile.mock.calls.length - 1,
    onRendererRecoveryExhausted
  }
}

describe('Windows renderer OOM recovery under exhausted commit', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    resetPreGoneSystemMemorySamplingForTest()
    setSwapVolumeFreeSpaceReaderForTest(async () => undefined)
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    setSystemMemoryInfoReaderForTest(null)
    setSwapVolumeFreeSpaceReaderForTest(null)
    resetPreGoneSystemMemorySamplingForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stops reloading into a repeat OOM and tells the user how much commit is left', async () => {
    const { reloads, onRendererRecoveryExhausted } = await runOomSequence('win32', [
      HEALTHY_FIRST_OOM_COMMIT_MB,
      EXHAUSTED_COMMIT_MB,
      EXHAUSTED_COMMIT_MB,
      EXHAUSTED_COMMIT_MB
    ])
    // The first OOM and the one 14 min later each still get their automatic reload.
    expect(reloads).toBe(2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        details: OOM,
        cause: 'low-commit',
        lowCommit: {
          availableCommitMB: EXHAUSTED_COMMIT_MB,
          sincePreviousOomMs: 3_458,
          commitReading: 'pre-gone'
        }
      })
    )
  })

  // The common field case: the 10 s sampler has no tick in the 3.458 s between the two OOMs.
  it('reads commit at gone time when no sampler tick landed since the previous OOM', async () => {
    const { reloads, onRendererRecoveryExhausted } = await runOomSequence('win32', [
      HEALTHY_FIRST_OOM_COMMIT_MB,
      EXHAUSTED_COMMIT_MB,
      null,
      EXHAUSTED_COMMIT_MB
    ])
    expect(reloads).toBe(2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'low-commit',
        lowCommit: {
          availableCommitMB: EXHAUSTED_COMMIT_MB,
          sincePreviousOomMs: 3_458,
          commitReading: 'gone-time'
        }
      })
    )
  })

  it('keeps reloading when the gone-time read shows commit recovered and no tick landed', async () => {
    const { reloads, onRendererRecoveryExhausted } = await runOomSequence(
      'win32',
      [HEALTHY_FIRST_OOM_COMMIT_MB, EXHAUSTED_COMMIT_MB, null, null],
      RECOVERED_COMMIT_MB
    )
    expect(reloads).toBe(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('keeps auto-reloading repeat OOMs once commit has recovered', async () => {
    const { reloads, onRendererRecoveryExhausted } = await runOomSequence('win32', [
      HEALTHY_FIRST_OOM_COMMIT_MB,
      RECOVERED_COMMIT_MB,
      RECOVERED_COMMIT_MB,
      RECOVERED_COMMIT_MB
    ])
    expect(reloads).toBe(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)('is a no-op on %s', async (platform) => {
    const { reloads, onRendererRecoveryExhausted } = await runOomSequence(platform, [
      EXHAUSTED_COMMIT_MB,
      EXHAUSTED_COMMIT_MB,
      EXHAUSTED_COMMIT_MB,
      EXHAUSTED_COMMIT_MB
    ])
    expect(reloads).toBe(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
  })
})
