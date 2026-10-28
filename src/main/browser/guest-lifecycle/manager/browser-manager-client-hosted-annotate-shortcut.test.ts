import { beforeEach, describe, expect, it, vi } from 'vitest'

const grabMocks = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestExecuteJavaScriptMock: vi.fn(),
  guestExecuteJavaScriptInIsolatedWorldMock: vi.fn(),
  guestIsDestroyedMock: vi.fn(() => false),
  guestGetZoomFactorMock: vi.fn(() => 1),
  guestCapturePageMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  rendererSendMock: vi.fn(),
  rendererIsDestroyedMock: vi.fn(() => false)
}))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: grabMocks.menuBuildFromTemplateMock },
  webContents: { fromId: grabMocks.webContentsFromIdMock }
}))

import { browserManager } from '../../browser-manager'
import {
  GRAB_GUEST_WEB_CONTENTS_ID,
  GRAB_RENDERER_WEB_CONTENTS_ID,
  resetGrabTestEnvironment
} from './browser-manager-grab-test-harness'

const { guestOnMock, rendererSendMock } = grabMocks

const annotateChord =
  process.platform === 'darwin'
    ? { meta: true, control: false, alt: false, shift: true, code: 'KeyC', key: 'C' }
    : { meta: false, control: false, alt: true, shift: true, code: 'KeyN', key: 'N' }

function pressAnnotateChord(): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn()
  for (const [eventName, handler] of guestOnMock.mock.calls) {
    if (eventName === 'before-input-event') {
      handler({ preventDefault }, { type: 'keyDown', ...annotateChord })
    }
  }
  return preventDefault
}

// A client-hosted page renders a remote workspace's browser tab with no local workspace id; its
// annotate chord must still reach the pane's annotation tools.
describe('annotate shortcut on a client-hosted page', () => {
  beforeEach(() => {
    resetGrabTestEnvironment(grabMocks)
  })

  it('forwards annotation for a guest that supports it without a local workspace', () => {
    guestOnMock.mockClear()
    browserManager.registerGuest({
      browserPageId: 'tab-1',
      supportsAnnotations: true,
      webContentsId: GRAB_GUEST_WEB_CONTENTS_ID,
      rendererWebContentsId: GRAB_RENDERER_WEB_CONTENTS_ID
    })
    rendererSendMock.mockClear()
    expect(pressAnnotateChord()).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:grabModeToggle', 'tab-1', 'annotate')

    guestOnMock.mockClear()
    browserManager.registerGuest({
      browserPageId: 'tab-1',
      webContentsId: GRAB_GUEST_WEB_CONTENTS_ID,
      rendererWebContentsId: GRAB_RENDERER_WEB_CONTENTS_ID
    })
    rendererSendMock.mockClear()
    expect(pressAnnotateChord()).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalled()
  })
})
