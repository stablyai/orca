import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))
vi.mock('./session-tab-close-request-relay', () => ({
  requestSessionTabCloseFromRenderer: vi.fn()
}))
vi.mock('./terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

function attachNotifier(): { notifier: RuntimeNotifier; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const attached: { notifier: RuntimeNotifier | null } = { notifier: null }
  const mainWindow = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send })
  })
  const runtime = {
    attachWindow: vi.fn(),
    setLocalTerminalWindowVisible: vi.fn(),
    removeLocalTerminalWindow: vi.fn(),
    setLocalTerminalWindowLease: vi.fn(),
    removeLocalTerminalWindowLease: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    setNotifier: (next: RuntimeNotifier | null) => {
      attached.notifier = next
    }
  }
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration uses this fixture's window identity, native visibility, lifecycle emitters and webContents notification methods.
    mainWindow as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration calls the supplied runtime attachment, terminal visibility and notification members.
    runtime as unknown as OrcaRuntimeService
  )
  if (!attached.notifier) {
    throw new Error('runtime notifier was not attached')
  }
  return { notifier: attached.notifier, send }
}

describe('runtime window file-open notifications', () => {
  it('omits navigation when the caller sent none (legacy switch)', () => {
    const { notifier, send } = attachNotifier()

    notifier.openFile?.('wt-1', '/repo/a.ts', 'a.ts', undefined)
    notifier.openDiff?.('wt-1', '/repo/a.ts', 'a.ts', true, undefined)

    expect(send).toHaveBeenCalledWith('ui:openFileFromMobile', {
      worktreeId: 'wt-1',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      runtimeEnvironmentId: undefined
    })
    expect(send).toHaveBeenCalledWith('ui:openDiffFromMobile', {
      worktreeId: 'wt-1',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      staged: true,
      runtimeEnvironmentId: undefined
    })
    for (const [, payload] of send.mock.calls) {
      expect(payload).not.toHaveProperty('navigation')
      expect(payload).not.toHaveProperty('position')
    }
  })

  it('adds position only when requested', () => {
    const { notifier, send } = attachNotifier()
    notifier.openFile?.('wt-1', '/repo/a.ts', 'a.ts', 'host-1', 'caller', { line: 12, column: 5 })
    expect(send).toHaveBeenCalledWith('ui:openFileFromMobile', {
      worktreeId: 'wt-1',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      runtimeEnvironmentId: 'host-1',
      navigation: 'caller',
      position: { line: 12, column: 5 }
    })
  })

  it('forwards an explicit navigation target to the renderer', () => {
    const { notifier, send } = attachNotifier()

    notifier.openFile?.('wt-1', '/repo/a.ts', 'a.ts', undefined, 'all')
    notifier.openDiff?.('wt-1', '/repo/a.ts', 'a.ts', false, undefined, 'caller')

    expect(send).toHaveBeenCalledWith(
      'ui:openFileFromMobile',
      expect.objectContaining({ navigation: 'all' })
    )
    expect(send).toHaveBeenCalledWith(
      'ui:openDiffFromMobile',
      expect.objectContaining({ navigation: 'caller' })
    )
  })
})
