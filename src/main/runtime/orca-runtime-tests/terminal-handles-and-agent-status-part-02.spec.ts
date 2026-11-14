import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { TEST_WORKTREE_PATH, store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('waits for delayed wrapper foreground cache enrichment', async () => {
    const getForegroundProcess = vi.fn(async () => (Date.now() >= 4_000 ? 'codex' : 'node'))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(4_200)

      await expect(result).resolves.toBe(true)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(20)
    } finally {
      vi.useRealTimers()
    }
  })
})
