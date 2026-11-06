import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../ipc/worktrees/listing/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: vi.fn()
}))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))
vi.mock('./session-tab-close-request-relay', () => ({
  requestSessionTabCloseFromRenderer: vi.fn()
}))
vi.mock('./terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

function attachNotifier() {
  const send = vi.fn()
  const markGraphReloadFailed = vi.fn()
  const attached: { notifier: RuntimeNotifier | null } = { notifier: null }
  const windowState = { destroyed: false }
  const mainWindow = {
    id: 1,
    isDestroyed: () => windowState.destroyed,
    on: vi.fn(),
    webContents: { isDestroyed: () => false, send, on: vi.fn() }
  }
  let onEvent!: (event: RuntimeClientEvent) => void
  const onClientEvent = vi.fn((listener: typeof onEvent, _options: unknown) => {
    onEvent = listener
    return vi.fn()
  })
  const runtime = {
    onClientEvent,
    attachWindow: vi.fn(),
    markGraphReloadFailed,
    setNotifier: (next: RuntimeNotifier | null) => {
      attached.notifier = next
    }
  }
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only the supplied window lifecycle and webContents members.
    mainWindow as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration calls only the supplied runtime attachment and notification members.
    runtime as unknown as OrcaRuntimeService
  )
  if (!attached.notifier?.setPaneTitle) {
    throw new Error('pane-title notifier was not attached')
  }
  return {
    setPaneTitle: attached.notifier.setPaneTitle,
    send,
    windowState,
    markGraphReloadFailed,
    onEvent: (event: RuntimeClientEvent) => onEvent(event),
    onClientEvent
  }
}

describe('pane title renderer emission receipts', () => {
  it('returns false without emitting to a destroyed desktop', () => {
    const { setPaneTitle, send, windowState } = attachNotifier()
    windowState.destroyed = true
    expect(setPaneTitle('tab-1', 'leaf-1', null)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a disposed frame once and refuses subsequent emissions', () => {
    const { setPaneTitle, send, markGraphReloadFailed } = attachNotifier()
    send.mockImplementation(() => {
      throw new Error('disposed frame')
    })
    expect(setPaneTitle('tab-1', 'leaf-1', 'REVIEWER')).toBe(false)
    expect(setPaneTitle('tab-1', 'leaf-1', 'OTHER')).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(markGraphReloadFailed).toHaveBeenCalledExactlyOnceWith(1, 'renderer-frame-unavailable')
  })
})

it('forwards follow-up installation notices without subscribing to terminal side effects', () => {
  const { onClientEvent, onEvent, send } = attachNotifier()
  expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
    consumesTerminalSideEffects: false
  })
  onEvent({ type: 'terminalSideEffects' } as never)
  expect(send).not.toHaveBeenCalled()
  onEvent({ type: 'prFollowUpsChanged' })
  expect(send).toHaveBeenCalledExactlyOnceWith('runtime:prFollowUpsChanged')
})
