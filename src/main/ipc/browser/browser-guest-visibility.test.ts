import { expect, it, vi } from 'vitest'
import type { BrowserGuestVisibilityReport } from '../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

const { listeners, previews, report, guest } = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  previews: new Set<string>(),
  report: vi.fn(() => true),
  guest: { id: 42 }
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      listeners.set(channel, listener),
    removeHandler: vi.fn(),
    handle: vi.fn()
  },
  webContents: { fromId: vi.fn() }
}))
vi.mock('../../browser/guest-lifecycle/browser-page-idle-discard', () => ({
  getBrowserPageIdleDiscard: () => ({ report })
}))
vi.mock('../../browser/guest-lifecycle/browser-page-memory', () => ({
  prepareBrowserPageAttach: vi.fn(),
  reserveBrowserPageDiscard: vi.fn(),
  acknowledgeBrowserPageRemoval: vi.fn()
}))
vi.mock(
  '../../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection',
  () => ({
    setBrowserGuestSemanticVisibility: vi.fn(),
    readBrowserGuestDiscardAdmission: vi.fn()
  })
)
vi.mock('../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { getAuthorizedGuest: () => guest }
}))
vi.mock('../../browser/document-preview/doc-preview-guest-policy', () => ({
  isWorkspaceDocPageId: (pageId: string) => previews.has(pageId)
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => true }))

import { registerBrowserGuestDiscardHandlers } from './browser-guest-discard-ipc'

// Perf contract: preview churn must never allocate browser idle-scheduler records.
it.each([20, 200])(
  'keeps %i preview lifecycles out of idle tracking but tracks browser pages',
  (count) => {
    report.mockClear()
    registerBrowserGuestDiscardHandlers()
    const sendVisibility = (browserPageId: string, visible: boolean): void => {
      const payload: BrowserGuestVisibilityReport = {
        browserPageId,
        webContentsId: guest.id,
        generation: visible ? 1 : 2,
        visible
      }
      listeners.get('browser:reportGuestVisibility')?.({ sender: { id: 99 } }, payload)
    }
    for (let index = 0; index < count; index++) {
      const pageId = `preview-${index}`
      previews.add(pageId)
      sendVisibility(pageId, true)
      sendVisibility(pageId, false)
      previews.delete(pageId)
    }
    expect(report).not.toHaveBeenCalled()
    sendVisibility('browser-page', false)
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(
      { browserPageId: 'browser-page', webContentsId: 42, generation: 2, visible: false },
      99,
      expect.any(Function)
    )
  }
)
