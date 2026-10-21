import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'

function fakeSession(): ExternalChromiumBrowserSession {
  const session: Pick<ExternalChromiumBrowserSession, 'run' | 'selectPage' | 'readTabs'> = {
    run: vi.fn(async () => ({ tabId: 'agent-tab-1' })),
    selectPage: vi.fn(async () => {}),
    readTabs: vi.fn(async () => [
      { tabId: 'agent-tab-1', url: 'about:blank', title: '', active: true }
    ])
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry calls only run, selectPage and readTabs on these paths.
  return session as ExternalChromiumBrowserSession
}

describe('external Chromium tab registry', () => {
  it('scopes a folder workspace through the browser-workspace resolver', async () => {
    // The git-only selector cannot name a folder workspace; only the browser resolver can.
    const resolveWorktreeSelector = vi.fn(async () => {
      throw new Error('selector_not_found')
    })
    const host: Pick<
      RuntimeBrowserCommandHost,
      'resolveWorktreeSelector' | 'resolveBrowserWorkspace'
    > = {
      resolveWorktreeSelector,
      resolveBrowserWorkspace: async () => ({ id: 'folder:docs' })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tab paths read only the two selector resolvers and optional notifiers.
    const commandHost = host as RuntimeBrowserCommandHost
    const registry = new ExternalChromiumTabRegistry(fakeSession())

    const created = z
      .object({ browserPageId: z.string() })
      .parse(await registry.createTab(commandHost, { worktree: 'id:folder:docs' }))
    const listed = z
      .object({ tabs: z.array(z.object({ browserPageId: z.string() })) })
      .parse(await registry.listTabs(commandHost, { worktree: 'id:folder:docs' }))

    expect(listed.tabs.map((tab) => tab.browserPageId)).toEqual([created.browserPageId])
    expect(resolveWorktreeSelector).not.toHaveBeenCalled()
  })
})
