import { beforeEach, describe, expect, it, vi } from 'vitest'

const { waitForTabFirstLoad, waitForTabRegistration } = vi.hoisted(() => ({
  waitForTabFirstLoad: vi.fn(async () => {}),
  waitForTabRegistration: vi.fn(async () => {})
}))
vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({
  waitForTabFirstLoad,
  waitForTabRegistration,
  waitForWorktreeTabRegistration: vi.fn(async () => {})
}))

import { RuntimeBrowserCommandTargets } from './browser-command-targets'

function targets(servedByHeadless: boolean) {
  const send = vi.fn()
  const host = {
    getAgentBrowserBridge: () => null,
    resolveWorktreeSelector: vi.fn(),
    getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } })),
    retireRuntimeOwnedBrowserSessionTab: vi.fn(),
    serveBrowserTabs: { start: vi.fn(async () => servedByHeadless) }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ensureBrowserPageActive reads only the members stubbed above.
  return { targets: new RuntimeBrowserCommandTargets(host as never), host, send }
}

describe('ensureBrowserPageActive', () => {
  beforeEach(() => vi.clearAllMocks())

  it('waits for the first load of a page headless serve starts', async () => {
    const { targets: subject, host } = targets(true)
    await subject.ensureBrowserPageActive('wt-1', 'page-1')
    expect(host.getAuthoritativeWindow).not.toHaveBeenCalled()
    expect(waitForTabFirstLoad).toHaveBeenCalledWith('page-1')
  })

  it('waits for registration, then the first load, of a page a window mounts', async () => {
    const { targets: subject, send } = targets(false)
    await subject.ensureBrowserPageActive('wt-1', 'page-1')
    expect(send).toHaveBeenCalledWith('browser:activateView', {
      worktreeId: 'wt-1',
      browserPageId: 'page-1'
    })
    expect(waitForTabRegistration).toHaveBeenCalledWith('page-1')
    expect(waitForTabFirstLoad).toHaveBeenCalledWith('page-1')
  })
})
