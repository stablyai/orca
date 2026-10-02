import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  noteTerminalPaneSpawn,
  recordTerminalLaunchRefusal,
  takeTerminalLaunchRefusal
} from './terminal-launch-refusals'
import { describeLaunchFileUnavailable } from '../../shared/launch-prompt-file'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function waitForHandle(
  runtime: OrcaRuntimeService,
  tabId: string,
  timeoutMs = 5_000
): Promise<string> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait under test is a protected member of the runtime; the assertion names only that method.
  const internal = runtime as unknown as {
    waitForTerminalHandle: (tabId: string, timeoutMs?: number) => Promise<string>
  }
  return internal.waitForTerminalHandle(tabId, timeoutMs)
}

describe('a pane spawn the host refused for its launch file', () => {
  const refusal = describeLaunchFileUnavailable(
    "the WSL distro's home directory could not be reached"
  )

  it('is taken once, by the tab it refused', () => {
    recordTerminalLaunchRefusal('tab-taken', refusal)
    expect(takeTerminalLaunchRefusal('tab-other')).toBeUndefined()
    expect(takeTerminalLaunchRefusal('tab-taken')).toBe(refusal)
    expect(takeTerminalLaunchRefusal('tab-taken')).toBeUndefined()
  })

  // Why: agent.launch waits on this handle; the refusal is its answer, not a 10 s timeout.
  it('ends a create waiting on that tab’s handle with the reason', async () => {
    const runtime = new OrcaRuntimeService()
    const waiting = waitForHandle(runtime, 'tab-waiting')
    recordTerminalLaunchRefusal('tab-waiting', refusal)
    await expect(waiting).rejects.toThrow(refusal)
  })

  it('ends a create that starts waiting after the refusal arrived', async () => {
    const runtime = new OrcaRuntimeService()
    recordTerminalLaunchRefusal('tab-early', refusal)
    await expect(waitForHandle(runtime, 'tab-early')).rejects.toThrow(refusal)
  })

  // Why: a cold WSL probe plus the spawn can outlast the create's wait; the agent then starts
  // anyway, so a timeout there would be false.
  it('keeps waiting past its budget while that tab’s spawn still runs, then times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const settleSpawn = noteTerminalPaneSpawn('tab-cold-wsl')
      let outcome: string | null = null
      waitForHandle(runtime, 'tab-cold-wsl', 100).catch((error: Error) => {
        outcome = error.message
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(outcome).toBeNull()
      settleSpawn()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(outcome).toMatch(/Timed out waiting for terminal handle/)
    } finally {
      vi.useRealTimers()
    }
  })
})
