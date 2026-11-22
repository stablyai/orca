import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  restartScripts: vi.fn(async () => {}),
  fireLifecycle: vi.fn(),
  notifyActions: vi.fn()
}))

vi.mock('../api-runtime/browser-extension-content-scripts', () => ({
  forgetBrowserExtensionSessionContentScripts: vi.fn(),
  restartBrowserExtensionContentScripts: mocks.restartScripts
}))
vi.mock('../declarative-net-request/session/browser-extension-dnr-store', () => ({
  getBrowserExtensionDnrStore: () => ({ forgetAllSessionRules: vi.fn() })
}))
vi.mock('../declarative-net-request/session/browser-extension-dnr-session', () => ({
  clearBrowserExtensionDnrSessionRules: vi.fn(async () => {})
}))
vi.mock('../side-panel/browser-extension-side-panel-options', () => ({
  forgetSidePanelExtensionOptions: vi.fn()
}))
vi.mock('../actions/browser-extension-action-registry', () => ({
  notifyBrowserExtensionActionsChanged: mocks.notifyActions
}))
vi.mock('./browser-extension-idle-kept-state', () => ({
  claimBrowserExtensionIdleState: vi.fn(),
  dropBrowserExtensionIdleState: vi.fn(),
  isBrowserExtensionResuming: () => true,
  onBrowserExtensionIdleStateDropped: vi.fn()
}))
vi.mock('./browser-extension-runtime-lifecycle', () => ({
  fireRuntimeLifecycleEvents: mocks.fireLifecycle
}))

const { settleBrowserExtensionResume } = await import('./browser-extension-idle-resume')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settle reads only the id
const extension = { id: 'ext' } as Electron.Extension

function fakeSession(): Electron.Session & { extensions: EventEmitter } {
  const extensions = Object.assign(new EventEmitter(), { getExtension: () => extension })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settle only uses extensions events and getExtension
  return { extensions } as unknown as Electron.Session & { extensions: EventEmitter }
}

describe('a resumed extension whose restore failed', () => {
  beforeEach(() => vi.clearAllMocks())

  it('repaints the toolbar and starts clean with onStartup', async () => {
    const sess = fakeSession()
    await settleBrowserExtensionResume(sess, 'p', extension, Promise.reject(new Error('x')), 10)
    expect(mocks.notifyActions).toHaveBeenCalledWith('p')
    expect(mocks.fireLifecycle).toHaveBeenCalledWith(sess, 'p', extension, 'startup')
  })

  it('sends no onStartup when the extension unloads during the cleanup', async () => {
    const sess = fakeSession()
    mocks.restartScripts.mockImplementationOnce(async () => {
      sess.extensions.emit('extension-unloaded', {}, extension)
    })
    await settleBrowserExtensionResume(sess, 'p', extension, Promise.reject(new Error('x')), 10)
    expect(mocks.fireLifecycle).not.toHaveBeenCalled()
  })
})
