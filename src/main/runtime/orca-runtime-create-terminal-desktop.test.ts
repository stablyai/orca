import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import type { OrcaRuntimeWithCreateTerminal } from './orca-runtime-create-terminal'
import { createDesktopTerminal } from './orca-runtime-create-terminal-desktop'
import { mapRuntimeError } from './rpc/errors'

const desktop = vi.hoisted(() => ({ onIpc: vi.fn(), removeIpcListener: vi.fn() }))
vi.mock('./orca-runtime-create-terminal-dependencies', () => ({
  randomUUID: () => 'request-1',
  getRuntimeDesktopSurface: () => desktop,
  ownerSurfacing: () => ({})
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('desktop terminal creation replies', () => {
  it.each([
    { errorCode: 'worktree_not_renderable', rpcCode: 'worktree_not_renderable' },
    { errorCode: undefined, rpcCode: 'runtime_error' }
  ])('rejects before waiting for a handle with code $errorCode', async ({ errorCode, rpcCode }) => {
    vi.useFakeTimers()
    const send = vi.fn((_channel: string, request: { requestId: string }) => {
      const handler = desktop.onIpc.mock.calls[0][1] as (
        event: IpcMainEvent,
        reply: TerminalTabCreateReply
      ) => void
      handler({ sender: win.webContents } as IpcMainEvent, {
        requestId: request.requestId,
        error: 'Show this worktree in the sidebar before creating a terminal.',
        ...(errorCode ? { errorCode } : {})
      })
    })
    const win = { webContents: { send } } as unknown as BrowserWindow
    const waitForTerminalHandle = vi.fn()
    const runtime = {
      assertGraphReady: vi.fn(),
      resolveTerminalWorkspaceLaunchScope: vi.fn().mockResolvedValue({ id: 'wt-hidden' }),
      resolveAgentTerminalCreateOptions: vi.fn().mockResolvedValue({ command: 'claude' }),
      resolveWorkspaceTerminalStartupCwd: vi.fn().mockReturnValue('/repo/hidden'),
      waitForTerminalHandle
    } as unknown as OrcaRuntimeWithCreateTerminal

    const error = await createDesktopTerminal(runtime, 'wt-hidden', {}, 'focused', win).catch(
      (error: unknown) => error
    )

    expect(error).toBeInstanceOf(Error)
    expect(mapRuntimeError('rpc-1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
      ok: false,
      error: {
        code: rpcCode,
        message: 'Show this worktree in the sidebar before creating a terminal.'
      }
    })
    expect(waitForTerminalHandle).not.toHaveBeenCalled()
    expect(desktop.removeIpcListener).toHaveBeenCalledWith(
      'terminal:tabCreateReply',
      desktop.onIpc.mock.calls[0][1]
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
