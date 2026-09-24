import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
import { Store } from '../persistence/loading-store/store'
import { OrcaRuntimeService } from './orca-runtime'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

export const ACK_WORKTREE = 'repo1::/tmp/worktree'
export const ACK_TAB = '11111111-1111-4111-8111-111111111111'
export const ACK_LEAF = '22222222-2222-4222-8222-222222222222'
export const ACK_SECOND_LEAF = '44444444-4444-4444-8444-444444444444'
export const ACK_INCARNATION = '33333333-3333-4333-8333-333333333333'
const SECOND_INCARNATION = '55555555-5555-4555-8555-555555555555'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export function createAcknowledgedTabRetirementFixture(bound = false) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-close-ack-'))
  const store = new Store({ dataFile: join(directory, 'orca-data.json') })
  store.addRepo({
    id: 'repo1',
    path: '/tmp/worktree',
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.setWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [ACK_WORKTREE]: [
        {
          id: ACK_TAB,
          worktreeId: ACK_WORKTREE,
          ptyId: bound ? 'pty-a' : null,
          title: 'Target',
          customTitle: null,
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    ...(bound
      ? {
          terminalLayoutsByTabId: {
            [ACK_TAB]: {
              root: {
                type: 'split',
                direction: 'horizontal',
                ratio: 0.5,
                first: { type: 'leaf', leafId: ACK_LEAF },
                second: { type: 'leaf', leafId: ACK_SECOND_LEAF }
              },
              activeLeafId: ACK_LEAF,
              expandedLeafId: null,
              ptyIdsByLeafId: { [ACK_LEAF]: 'pty-a', [ACK_SECOND_LEAF]: 'pty-b' }
            }
          },
          terminalPtyIncarnationsByPaneKey: {
            [`${ACK_TAB}:${ACK_LEAF}`]: ACK_INCARNATION,
            [`${ACK_TAB}:${ACK_SECOND_LEAF}`]: SECOND_INCARNATION
          }
        }
      : {})
  })
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exercised close path only checks window and WebContents destruction.
      return { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as never
    },
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const runtime = new OrcaRuntimeService(store)
  runtime.attachWindow(1)
  if (bound) {
    runtime.registerPty('pty-a', ACK_WORKTREE, null, {
      tabId: ACK_TAB,
      leafId: ACK_LEAF,
      incarnationId: ACK_INCARNATION
    })
    runtime.registerPty('pty-b', ACK_WORKTREE, null, {
      tabId: ACK_TAB,
      leafId: ACK_SECOND_LEAF,
      incarnationId: SECOND_INCARNATION
    })
  }
  function publish(present: boolean, version: number, includedLeaves?: readonly string[]): void {
    const session = store.getWorkspaceSession()
    const projected = present
      ? buildHeadlessMobileSessionTerminalTabs(
          ACK_WORKTREE,
          session.tabsByWorktree[ACK_WORKTREE],
          session
        )
      : []
    const tabs = includedLeaves
      ? projected.filter((tab) => includedLeaves.includes(tab.leafId))
      : projected
    const graph: RuntimeSyncWindowGraph = {
      tabs: present
        ? [
            {
              tabId: ACK_TAB,
              worktreeId: ACK_WORKTREE,
              title: 'Target',
              activeLeafId: null,
              layout: null
            }
          ]
        : [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: ACK_WORKTREE,
          publicationEpoch: 'renderer:ack',
          activeGroupId: null,
          snapshotVersion: version,
          activeTabId: tabs[0]?.id ?? null,
          activeTabType: tabs.length ? 'terminal' : null,
          tabs
        }
      ]
    }
    runtime.syncWindowGraph(1, graph)
  }
  publish(true, 1)
  store.setWorkspaceSession(
    advanceTerminalTopologyRevision(store.getWorkspaceSession(), ACK_WORKTREE)
  )
  const entered = deferred()
  const acknowledgement = deferred()
  const closeTerminalTab = vi.fn(async () => {
    const closed = closeTerminalTabInWorkspaceSession(
      store.getWorkspaceSession(),
      ACK_WORKTREE,
      ACK_TAB
    )
    store.setWorkspaceSession({ ...closed.session, terminalTopologyRevisionByRepoId: undefined })
    store.flushOrThrow()
    entered.resolve()
    await acknowledgement.promise
  })
  runtime.setNotifier({
    closeTerminalTab,
    closeTerminal: () => {},
    worktreesChanged: () => {},
    reposChanged: () => {},
    activateWorktree: () => {},
    createTerminal: () => {},
    splitTerminal: () => {},
    renameTerminal: () => {},
    focusTerminal: () => {},
    sleepWorktree: () => {},
    terminalFitOverrideChanged: () => {},
    terminalDriverChanged: () => {}
  })
  return {
    runtime,
    store,
    entered,
    acknowledgement,
    closeTerminalTab,
    publish,
    hasTab: () =>
      store.getWorkspaceSession().tabsByWorktree[ACK_WORKTREE].some((tab) => tab.id === ACK_TAB),
    close: (options: { force?: boolean } = {}) =>
      runtime.closeMobileSessionTab(`id:${ACK_WORKTREE}`, ACK_TAB, { reason: 'user', ...options }),
    dispose: async () => {
      runtime.setNotifier(null)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
      store.flush()
      store.freezeWrites()
      await store.waitForPendingWrite()
      setRuntimeDesktopSurface(null)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
