import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, trackMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: showMessageBoxMock
  }
}))

vi.mock('../i18n/main-i18n', () => ({
  // Why: substitute every supplied placeholder, not just {{cause}} — a mock that ignores one
  // would leave a literal {{...}} in the detail and hide it from every assertion below.
  translateMain: (
    _key: string,
    fallback: string,
    options?: Readonly<Record<string, string>>
  ): string =>
    Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
      fallback
    )
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

import {
  classifyRuntimeRpcStartFailure,
  recordRuntimeRpcStartFailure,
  showRuntimeRpcStartupFailureDialog
} from './runtime-rpc-startup-failure'

type FakeParentWindow = Electron.BrowserWindow & EventEmitter

function createParentWindow(
  visible = true,
  destroyed = false,
  webContentsDestroyed = destroyed
): FakeParentWindow {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => webContentsDestroyed
  })
  const parentWindow = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isVisible: () => visible
  }) as unknown as FakeParentWindow
  Object.defineProperty(parentWindow, 'webContents', {
    get: () => {
      if (destroyed) {
        throw new Error('Object has been destroyed')
      }
      return webContents
    }
  })
  return parentWindow
}

// Why: the dialog is deferred behind an await, so a synchronous "not called yet" assertion
// would pass even if the deferral were deleted; drain the microtask queue first.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe('runtime RPC startup failure reporting', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset().mockResolvedValue({ response: 0 })
    trackMock.mockReset()
  })

  it.each([
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['EADDRINUSE', 'address_in_use'],
    ['ENOSPC', 'storage_unavailable'],
    ['EROFS', 'storage_unavailable'],
    ['EINVAL', 'invalid_path'],
    ['ENOENT', 'invalid_path'],
    ['ENAMETOOLONG', 'invalid_path'],
    ['unexpected', 'unknown']
  ] as const)('classifies %s without exposing the raw error', (code, expected) => {
    const error = Object.assign(new Error('/Users/private/orca-runtime.json'), { code })

    expect(classifyRuntimeRpcStartFailure(error)).toBe(expected)
  })

  it('classifies a code carried on a wrapped cause', () => {
    const error = new Error('failed to publish orca-runtime.json', {
      cause: Object.assign(new Error('read-only volume'), { code: 'EROFS' })
    })

    expect(classifyRuntimeRpcStartFailure(error)).toBe('storage_unavailable')
  })

  it('walks past an unmapped wrapper code to the mapped cause', () => {
    const error = Object.assign(new Error('failed to publish orca-runtime.json'), {
      code: 'ERR_PUBLISH_FAILED',
      cause: Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    expect(classifyRuntimeRpcStartFailure(error)).toBe('permission_denied')
  })

  it('survives a self-referential cause chain', () => {
    const error: Error & { cause?: unknown } = new Error('cyclic')
    error.cause = error

    expect(classifyRuntimeRpcStartFailure(error)).toBe('unknown')
  })

  it('records a privacy-safe telemetry event', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = Object.assign(new Error('/Users/private/orca-runtime.json'), { code: 'EACCES' })

    recordRuntimeRpcStartFailure(error)

    expect(trackMock).toHaveBeenCalledWith('runtime_rpc_start_failed', {
      error_class: 'permission_denied'
    })
    expect(JSON.stringify(trackMock.mock.calls)).not.toContain('/Users/private')
    consoleError.mockRestore()
  })

  it('does not let telemetry failure escape the startup failure handler', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const telemetryError = new Error('telemetry unavailable')
    trackMock.mockImplementationOnce(() => {
      throw telemetryError
    })

    expect(() => recordRuntimeRpcStartFailure(new Error('RPC failed'))).not.toThrow()
    expect(consoleError).toHaveBeenCalledWith(
      '[runtime] Failed to record RPC startup failure telemetry:',
      telemetryError
    )
    consoleError.mockRestore()
  })

  it('shows the CLI impact and local cause', async () => {
    const parentWindow = createParentWindow()
    const error = new Error('metadata write failed')

    await showRuntimeRpcStartupFailureDialog(parentWindow, error)

    expect(showMessageBoxMock).toHaveBeenCalledWith(
      parentWindow,
      expect.objectContaining({
        type: 'error',
        title: 'Orca CLI unavailable',
        message: "Orca couldn't start its local command transport.",
        detail: expect.stringMatching(
          /orca status.*orca terminal.*orchestration.*Cause: metadata write failed/s
        )
      })
    )
  })

  // Why: a bare "restart" is only true for address_in_use — the other classes need the user to
  // change something, so each must reach the dialog with its own remediation.
  it.each([
    ['EACCES', "Check permissions on Orca's data folder"],
    ['EPERM', "Check permissions on Orca's data folder"],
    ['ENOSPC', 'Your disk may be full or read-only'],
    ['EROFS', 'Your disk may be full or read-only'],
    ['EINVAL', 'at a path that is too long'],
    ['ENAMETOOLONG', 'at a path that is too long'],
    ['ENOENT', "Orca's data folder may be missing"],
    ['EADDRINUSE', 'Another process may be holding the port']
  ] as const)('guides the user on how to fix %s', async (code, guidance) => {
    const error = Object.assign(new Error('metadata write failed'), { code })

    await showRuntimeRpcStartupFailureDialog(createParentWindow(), error)

    const detail = showMessageBoxMock.mock.calls[0]?.[1]?.detail as string
    expect(detail).toContain(guidance)
    expect(detail).not.toContain('{{')
  })

  it('falls back to a plain restart when the cause is unrecognised', async () => {
    await showRuntimeRpcStartupFailureDialog(createParentWindow(), new Error('mystery'))

    const detail = showMessageBoxMock.mock.calls[0]?.[1]?.detail as string
    expect(detail).toContain('Restart Orca to try again.')
    expect(detail).not.toContain("Check permissions on Orca's data folder")
  })

  it('truncates a runaway cause instead of pasting it whole into the dialog', async () => {
    await showRuntimeRpcStartupFailureDialog(createParentWindow(), new Error('x'.repeat(900)))

    const detail = showMessageBoxMock.mock.calls[0]?.[1]?.detail as string
    const cause = detail.slice(detail.indexOf('Cause: ') + 'Cause: '.length)
    expect(cause).toHaveLength(500)
    expect(cause.endsWith('…')).toBe(true)
  })

  it('waits until the app window is visible', async () => {
    const parentWindow = createParentWindow(false)
    const reporting = showRuntimeRpcStartupFailureDialog(
      parentWindow,
      new Error('metadata write failed')
    )

    await flushMicrotasks()
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    parentWindow.emit('show')
    await reporting

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    expect(parentWindow.listenerCount('show')).toBe(0)
    expect(parentWindow.webContents.listenerCount('destroyed')).toBe(0)
  })

  it('never shows a dialog against an already destroyed window', async () => {
    const parentWindow = createParentWindow(false, true)

    await showRuntimeRpcStartupFailureDialog(parentWindow, new Error('metadata write failed'))

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(parentWindow.listenerCount('show')).toBe(0)
  })

  it('never waits on already destroyed web contents', async () => {
    const parentWindow = createParentWindow(false, false, true)

    await showRuntimeRpcStartupFailureDialog(parentWindow, new Error('metadata write failed'))

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(parentWindow.listenerCount('show')).toBe(0)
    expect(parentWindow.webContents.listenerCount('destroyed')).toBe(0)
  })

  it('drops the pending dialog and its listeners when the window closes first', async () => {
    const parentWindow = createParentWindow(false)
    const reporting = showRuntimeRpcStartupFailureDialog(
      parentWindow,
      new Error('metadata write failed')
    )

    await flushMicrotasks()
    expect(parentWindow.listenerCount('closed')).toBe(0)
    expect(parentWindow.webContents.listenerCount('destroyed')).toBe(1)
    parentWindow.webContents.emit('destroyed')
    await reporting

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(parentWindow.listenerCount('show')).toBe(0)
    expect(parentWindow.webContents.listenerCount('destroyed')).toBe(0)
  })

  it('logs instead of rejecting if Electron cannot show the dialog', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    showMessageBoxMock.mockRejectedValueOnce(new Error('window closed'))

    await expect(
      showRuntimeRpcStartupFailureDialog(createParentWindow(), new Error('failed'))
    ).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith(
      '[runtime] Failed to show RPC startup failure dialog:',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })
})
