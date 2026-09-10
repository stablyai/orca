import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitter = new EventEmitter()
const ipcMain = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) =>
    emitter.on(channel, listener)
  ),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) =>
    emitter.removeListener(channel, listener)
  )
}
vi.mock('electron', () => ({ ipcMain }))

describe('requestMaestroWorkspaceTabCommand', () => {
  beforeEach(() => emitter.removeAllListeners())

  it('accepts only the exact renderer acknowledgement and tab identity', async () => {
    const { requestMaestroWorkspaceTabCommand } =
      await import('./maestro-workspace-tab-command-relay')
    const webContents = { send: vi.fn() }
    const pending = requestMaestroWorkspaceTabCommand({ webContents } as never, {
      kind: 'open-annotation',
      worktreeId: 'workspace-1',
      filePath: '/workspace/note.md',
      relativePath: 'note.md'
    })
    const command = webContents.send.mock.calls[0]![1] as { requestId: string }
    emitter.emit(
      'ui:maestroWorkspaceTabCommandResponse',
      { sender: {} },
      {
        requestId: command.requestId,
        ok: true,
        tabId: 'forged-tab'
      }
    )
    emitter.emit(
      'ui:maestroWorkspaceTabCommandResponse',
      { sender: webContents },
      {
        requestId: command.requestId,
        ok: true,
        tabId: 'exact-tab'
      }
    )
    await expect(pending).resolves.toEqual({ tabId: 'exact-tab' })
  })

  it('rejects a renderer response without exact tab identity', async () => {
    const { requestMaestroWorkspaceTabCommand } =
      await import('./maestro-workspace-tab-command-relay')
    const webContents = { send: vi.fn() }
    const pending = requestMaestroWorkspaceTabCommand({ webContents } as never, {
      kind: 'rename',
      worktreeId: 'workspace-1',
      tabId: 'tab-1',
      title: 'Renamed'
    })
    const command = webContents.send.mock.calls[0]![1] as { requestId: string }
    emitter.emit(
      'ui:maestroWorkspaceTabCommandResponse',
      { sender: webContents },
      {
        requestId: command.requestId,
        ok: true
      }
    )
    await expect(pending).rejects.toThrow('failed')
  })
})
