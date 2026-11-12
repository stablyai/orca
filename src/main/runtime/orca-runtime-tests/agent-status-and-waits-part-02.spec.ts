import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import '../orca-runtime'
import '../../providers/pty-process-inspection'
import '../../../shared/workspace-layout/stable-pane-id'

import { createExplicitAgentStatusHarness, deferred } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('rejects foreground evidence when the handle rebinds during the ordinary read', async () => {
    const foreground = deferred<string | null>()
    const getForegroundProcess = vi.fn(() => foreground.promise)
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledWith('pty-1'))
    syncPty('pty-2')
    foreground.resolve('zsh')

    await expect(status).rejects.toThrow('terminal_handle_stale')
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('rejects confirmation evidence when the handle rebinds during the fresh read', async () => {
    const confirmation = deferred<string | null>()
    const confirmForegroundProcess = vi.fn(() => confirmation.promise)
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'powershell.exe',
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1'))
    syncPty('pty-2')
    confirmation.resolve('codex')

    await expect(status).rejects.toThrow('terminal_handle_stale')
  })
})
