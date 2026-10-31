import { afterEach, expect, it, vi } from 'vitest'
import { PROCESS_TABLE_EVIDENCE_BUDGET_MS } from '../../../shared/process-table-snapshot-reader'
import { OrcaRuntimeService } from '../orca-runtime'

afterEach(() => {
  vi.useRealTimers()
})

it.skipIf(process.platform === 'win32')(
  'proves nothing paused when the process table is slower than the evidence budget',
  async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      listProcesses: () => new Promise(() => {}),
      getForegroundProcess: async () => null
    })
    let settled: boolean | undefined
    void runtime.terminalAgentPaused('pty-1').then((paused) => {
      settled = paused
    })
    await vi.advanceTimersByTimeAsync(PROCESS_TABLE_EVIDENCE_BUDGET_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
  }
)
