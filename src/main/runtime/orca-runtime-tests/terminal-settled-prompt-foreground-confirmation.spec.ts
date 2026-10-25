import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

// Confirm unfamiliar foreground names before downgrading atomic paste; unframed chunks truncated Claude prompts (STA-4577).
describe('isTerminalRunningSettledPromptAgent foreground confirmation', () => {
  // macOS p_comm may report the Claude version directory; Windows may report bash.exe until its scan finishes.
  it.each(['2.1.258', 'bash.exe'])(
    'confirms an unrecognized foreground (%s) before refusing the settled route',
    async (cachedForeground) => {
      const getForegroundProcess = vi.fn(async () => cachedForeground)
      const confirmForegroundProcess = vi.fn(async () => 'claude')
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess,
        confirmForegroundProcess
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
      const [terminal] = (await runtime.listTerminals()).terminals

      await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(true)
      expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1')
      expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps legacy delivery when confirmation also finds no target agent', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'vim')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.258',
      confirmForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(false)
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it('does not confirm when the cached foreground already names a target agent', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'claude')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      confirmForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(true)
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('refuses the settled route when the provider cannot confirm', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.258'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(false)
  })
})
