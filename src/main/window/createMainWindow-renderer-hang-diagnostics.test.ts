import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)
const { disposeWatchdog, disposePolicy, installWatchdog, installPolicy } = vi.hoisted(() => {
  const disposeWatchdog = vi.fn()
  const disposePolicy = vi.fn()
  return {
    disposeWatchdog,
    disposePolicy,
    installWatchdog: vi.fn(() => ({ dispose: disposeWatchdog })),
    installPolicy: vi.fn((_webContents: unknown, _documentPath: string) => ({
      dispose: disposePolicy
    }))
  }
})
vi.mock('../crash-reporting/renderer-unresponsive-breadcrumb', () => ({
  installRendererUnresponsiveBreadcrumb: installWatchdog
}))
vi.mock('./main-document-call-stack-policy', () => ({
  installMainDocumentCallStackPolicy: installPolicy
}))

import { join } from 'node:path'
import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, isMock, resetMainWindowMocks } from './createMainWindow-test-harness'

function setupWindow() {
  const windowHandlers: Record<string, (...args: any[]) => void> = {}
  const webContents = {
    on: vi.fn(),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    id: 1
  }
  const instance = {
    webContents,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      windowHandlers[event] = handler
    }),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => true),
    isFullScreen: vi.fn(() => false),
    getSize: vi.fn(() => [1200, 800]),
    setSize: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve())
  }
  browserWindowMock.mockImplementation(function () {
    return instance
  })
  return { windowHandlers, webContents, instance }
}

describe('createMainWindow renderer hang diagnostics', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    installWatchdog.mockClear()
    installPolicy.mockClear()
    disposeWatchdog.mockClear()
    disposePolicy.mockClear()
    vi.unstubAllEnvs()
  })

  it('opts the packaged main document into JS stacks before loading it, and disposes both on close', () => {
    const { windowHandlers, webContents, instance } = setupWindow()
    const window = createMainWindow(null)

    expect(installWatchdog).toHaveBeenCalledWith(window)
    const [policyContents, documentPath = ''] = installPolicy.mock.calls[0] ?? []
    expect(policyContents).toBe(webContents)
    expect(instance.loadFile).toHaveBeenCalledWith(documentPath)
    expect(documentPath.endsWith(join('renderer', 'index.html'))).toBe(true)
    expect(installPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      instance.loadFile.mock.invocationCallOrder[0] ?? 0
    )

    windowHandlers.closed()
    expect(disposeWatchdog).toHaveBeenCalledTimes(1)
    expect(disposePolicy).toHaveBeenCalledTimes(1)
  })

  it('leaves the dev server document to its own Document-Policy header', () => {
    isMock.dev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const { instance } = setupWindow()
    createMainWindow(null)
    expect(installPolicy).not.toHaveBeenCalled()
    expect(installWatchdog).toHaveBeenCalledTimes(1)
    expect(instance.loadURL).toHaveBeenCalledWith('http://localhost:5173')
  })

  it('still loads the window when the policy cannot be installed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installPolicy.mockImplementationOnce(() => {
      throw new Error('protocol unavailable')
    })
    const { instance } = setupWindow()
    createMainWindow(null)
    expect(instance.loadFile).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
