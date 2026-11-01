import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { BrowserBackend } from '../browser/browser-backend'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import { ServeBrowserTabs } from './serve-browser-tabs'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WT = 'repo-1::/repo'
const PAGE = { worktreeId: WT, pageId: 'page-1', url: 'http://localhost:3000/', title: 'App' }

/** A served host with one saved page whose backend creation the test controls. */
async function savedPageHost(backend: Pick<BrowserBackend, 'createTab' | 'closeTab'>) {
  const host: { session: WorkspaceSessionState } = { session: getDefaultWorkspaceSession() }
  const tabs = new ServeBrowserTabs({
    backend: () => ({ ...backend, ownsTab: () => false }),
    livePageIds: () => new Set(),
    savedWorktreeIds: () => [WT],
    session: () => host.session,
    hostId: () => 'ssh:box',
    save: (_worktreeId: string, next: WorkspaceSessionState) => {
      host.session = next
    },
    applyLayout: async (
      command: LayoutCommand,
      hostId: ExecutionHostId
    ): Promise<LayoutApplyOutcome> => {
      const change = applyCommandToSession(hostId, host.session, command)
      host.session = change.session ?? host.session
      return change.value
    }
  })
  tabs.opened(PAGE)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { tabs, host }
}

it("restores a saved page on its session's host, not by its bare worktree id", async () => {
  const createTab = vi.fn(async () => ({ browserPageId: PAGE.pageId }))
  const { tabs } = await savedPageHost({ createTab, closeTab: vi.fn() })

  await expect(tabs.start(WT, PAGE.pageId)).resolves.toBe(true)

  expect(createTab).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: WT, executionHostId: 'ssh:box' })
  )
})

it('joins a second start of a page whose creation still awaits the SSH route', async () => {
  const routes: (() => void)[] = []
  const finishRoute = (): void => routes.forEach((finish) => finish())
  const createTab = vi.fn(
    () =>
      new Promise<{ browserPageId: string }>((resolve) => {
        routes.push(() => resolve({ browserPageId: PAGE.pageId }))
      })
  )
  const { tabs } = await savedPageHost({ createTab, closeTab: vi.fn() })

  const first = tabs.start(WT, PAGE.pageId)
  const second = tabs.start(WT, PAGE.pageId)
  finishRoute()

  await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  expect(createTab).toHaveBeenCalledTimes(1)
})

it('closes a restored page whose tab closed while its creation awaited the SSH route', async () => {
  const closeTab = vi.fn(async () => {})
  const state: { host?: { session: WorkspaceSessionState } } = {}
  // The tab is closed from another client while route preparation awaits SSH.
  const createTab = vi.fn(async () => {
    state.host!.session = getDefaultWorkspaceSession()
    return { browserPageId: PAGE.pageId }
  })
  const { tabs, host } = await savedPageHost({ createTab, closeTab })
  state.host = host

  await expect(tabs.start(WT, PAGE.pageId)).resolves.toBe(false)

  expect(closeTab).toHaveBeenCalledWith(PAGE.pageId)
})
