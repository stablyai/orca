import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../runtime-client'
import { resolveOrchestrationTerminalHandle } from './orchestration/terminal-identity'

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

afterEach(() => {
  restoreEnv('ORCA_TERMINAL_HANDLE', originalTerminalHandle)
  restoreEnv('ORCA_PANE_KEY', originalPaneKey)
})

describe('orchestration terminal identity', () => {
  it('refreshes caller evidence after resolving a stale handle by pane', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_1:leaf_1'
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('terminal_handle_stale', 'stale'))
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_reminted' } } })
    const refresh = vi.fn()

    const handle = await resolveOrchestrationTerminalHandle(
      new Map(),
      '/tmp/repo',
      {
        call,
        refreshOrchestrationCallerHandleAfterPaneRemint: refresh
      } as never,
      'from',
      { validateEnvHandle: true }
    )

    expect(handle).toBe('term_reminted')
    expect(refresh).toHaveBeenCalledWith('term_stale', 'tab_1:leaf_1', 'term_reminted')
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
