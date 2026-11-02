import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { Tab, TabGroupLayoutNode } from '../../../shared/tab-types'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from '../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const worktreeId = FIXTURE_GIT_WORKTREE_ID
const groupLayout: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', groupId: 'group-left' },
  second: { type: 'leaf', groupId: 'group-right' }
}

class HeadlessBrowserRuntime extends OrcaRuntimeService {
  seedSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    this.storeMobileSessionSnapshot(worktreeId, snapshot)
  }

  placeBrowserInRightGroup(focusesHost: boolean): void {
    this.markHeadlessBrowserSessionTabActive(worktreeId, 'page-new', {
      targetGroupId: 'group-right',
      focusesHost
    })
  }
}

function savedBrowserTab(id: string, groupId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: 'browser',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

describe('headless browser group persistence', () => {
  it.each([true, false])(
    'persists browser placement before publishing when focusesHost=%s',
    async (focusesHost) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-browser-group-'))
      const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
      try {
        store.setWorkspaceSession({
          ...store.getWorkspaceSession(),
          unifiedTabs: {
            [worktreeId]: [
              savedBrowserTab('page-left', 'group-left', 0),
              savedBrowserTab('page-right', 'group-right', 1),
              savedBrowserTab('page-new', 'group-left', 2)
            ]
          },
          tabGroups: {
            [worktreeId]: [
              {
                id: 'group-left',
                worktreeId,
                activeTabId: 'page-left',
                tabOrder: ['page-left', 'page-new']
              },
              {
                id: 'group-right',
                worktreeId,
                activeTabId: 'page-right',
                tabOrder: ['page-right']
              }
            ]
          },
          tabGroupLayouts: { [worktreeId]: groupLayout }
        })
        const runtime = new HeadlessBrowserRuntime(store)
        const registry = getRuntimeBrowserPageRegistry(runtime)
        const pages = ['page-left', 'page-right', 'page-new'].map((browserPageId) =>
          registry.publishClientPage({
            browserPageId,
            workspaceId: worktreeId,
            browserProfileId: 'default',
            executionHostKey: 'native:host:1',
            placement: {
              kind: 'client',
              browserHostClientId: 'host',
              browserHostGeneration: 1,
              pageHostGeneration: 1
            },
            url: 'about:blank',
            title: browserPageId,
            loading: false,
            active: browserPageId === 'page-left'
          })
        )
        runtime.seedSnapshot({
          worktree: worktreeId,
          publicationEpoch: 'headless:before',
          snapshotVersion: 1,
          activeGroupId: 'group-left',
          activeTabId: 'page-left',
          activeTabType: 'browser',
          tabGroups: store.getWorkspaceSession().tabGroups?.[worktreeId],
          tabGroupLayout: groupLayout,
          tabs: pages.map((page) => ({
            ...page,
            type: 'browser' as const,
            id: page.browserPageId,
            browserWorkspaceId: page.browserPageId,
            isActive: page.active
          }))
        })
        const published = vi.fn(() => {
          const accepted = store.getWorkspaceSession()
          expect(accepted.tabGroups?.[worktreeId]).toEqual([
            {
              id: 'group-left',
              worktreeId,
              activeTabId: 'page-left',
              tabOrder: ['page-left']
            },
            {
              id: 'group-right',
              worktreeId,
              activeTabId: focusesHost ? 'page-new' : 'page-right',
              tabOrder: ['page-right', 'page-new']
            }
          ])
          expect(
            accepted.unifiedTabs?.[worktreeId].find((tab) => tab.id === 'page-new')?.groupId
          ).toBe('group-right')
          expect(accepted.tabGroupLayouts?.[worktreeId]).toEqual(groupLayout)
        })
        const unsubscribe = runtime.onMobileSessionTabsChanged(published)
        try {
          expect(() => runtime.placeBrowserInRightGroup(focusesHost)).not.toThrow()
          expect(published).toHaveBeenCalledOnce()
        } finally {
          unsubscribe()
        }
      } finally {
        await store.freezeWritesAsync()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
