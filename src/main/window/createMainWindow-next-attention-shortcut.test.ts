import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

function setUpWindow(): {
  beforeInputEvent: (event: unknown, input: unknown) => void
  send: ReturnType<typeof vi.fn>
} {
  const windowHandlers: Record<string, (...args: unknown[]) => void> = {}
  const webContents = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      windowHandlers[event] = handler
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      windowHandlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn()
  }
  const browserWindowInstance = {
    webContents,
    on: vi.fn(),
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
    return browserWindowInstance
  })

  createMainWindow(null, {
    getKeybindings: () => ({ 'workspace.nextAttention': ['Mod+Shift+L'] })
  })

  return { beforeInputEvent: windowHandlers['before-input-event'], send: webContents.send }
}

const chord =
  process.platform === 'darwin'
    ? {
        type: 'keyDown',
        code: 'KeyL',
        key: 'L',
        meta: true,
        control: false,
        alt: false,
        shift: true
      }
    : {
        type: 'keyDown',
        code: 'KeyL',
        key: 'L',
        meta: false,
        control: true,
        alt: false,
        shift: true
      }

describe('createMainWindow next-attention shortcut', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
  })

  it('sends the jump to the renderer on a fresh key press', () => {
    const { beforeInputEvent, send } = setUpWindow()
    const preventDefault = vi.fn()

    beforeInputEvent({ preventDefault }, { ...chord, isAutoRepeat: false })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ui:jumpToNextAttention')
  })

  it('absorbs held-key repeats without jumping again', () => {
    const { beforeInputEvent, send } = setUpWindow()
    const preventDefault = vi.fn()

    beforeInputEvent({ preventDefault }, { ...chord, isAutoRepeat: true })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalledWith('ui:jumpToNextAttention')
  })
})
