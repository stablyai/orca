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

describe('ensureBrowserPageActive', () => {
  beforeEach(() => vi.clearAllMocks())

  it('waits for the first load of a page headless serve starts', async () => {
    const host = {
      getAuthoritativeWindow: vi.fn(),
      serveBrowserTabs: { start: vi.fn(async () => true) }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ensureBrowserPageActive reads only the members stubbed above.
    await new RuntimeBrowserCommandTargets(host as never).ensureBrowserPageActive('wt-1', 'page-1')
    expect(host.getAuthoritativeWindow).not.toHaveBeenCalled()
    expect(waitForTabFirstLoad).toHaveBeenCalledWith('page-1')
  })
})
