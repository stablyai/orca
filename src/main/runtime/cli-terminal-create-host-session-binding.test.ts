/** A host-initiated create has no renderer session writer, so only its own
 *  durable binding and runtime ownership keep graph sync from pruning the tab
 *  out from under a live agent — including when a window is attached. */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function createRuntimeWithAttachedWindow(): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'repo-1::/tmp/wt-cli',
    path: '/tmp/wt-cli',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi.fn().mockResolvedValue({ id: 'repo-1::/tmp/wt-cli@@a1b2c3d4' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return { runtime, spawn }
}

describe('host-initiated terminal creation under an attached window', () => {
  it('persists the host session binding at spawn', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ persistHostSessionBinding: true }))
  })

  it('marks the spawned PTY runtime-session-owned', async () => {
    const { runtime } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { runtimeSessionOwned: boolean; connected: boolean }>
      }
    ).ptysById.get('repo-1::/tmp/wt-cli@@a1b2c3d4')
    expect(pty?.connected).toBe(true)
    expect(pty?.runtimeSessionOwned).toBe(true)
  })
})
