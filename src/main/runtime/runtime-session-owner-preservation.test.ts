import { tmpdir } from 'node:os'
import type * as TerminalHistoryDeletion from '../terminal-history-deletion'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { SSH_PANE_RECOVERY_GRACE_MS } from './orca-runtime-core'
import {
  createSessionOwnerFixture,
  SESSION_OWNER_WORKTREE_ID as id
} from './runtime-session-owner.test-fixture'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../terminal-history-deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalHistoryDeletion>()),
  deleteWorktreeHistoryDir: vi.fn()
}))

describe('saved tabs remain attached to their checked session owner', () => {
  it('releases a durably retired local pane while its same-ID SSH sibling survives', async () => {
    const f = createSessionOwnerFixture(false, false)
    const sshSession = f.store.getWorkspaceSession('ssh:session-b')
    f.store.addRepo({
      id: 'repo-session-owner',
      path: '/repo',
      displayName: 'Local repo',
      badgeColor: 'blue',
      addedAt: 1,
      executionHostId: 'local'
    })
    const meta = f.store.setWorktreeMetaForHost(id, 'local', {})
    if (!meta.instanceId) {
      throw new Error('Missing local occupant')
    }
    const owner = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'local',
      instanceId: meta.instanceId
    })
    const panes = [1, 2].map((index) => ({
      tabId: `local-tab-${index}`,
      leafId: randomUUID(),
      ptyId: `${id}@@${randomUUID()}`
    }))
    const localSession = getDefaultWorkspaceSession()
    localSession.tabsByWorktree[id] = panes.map((pane) =>
      makeTerminalTab({ id: pane.tabId, worktreeId: id, ptyId: pane.ptyId })
    )
    localSession.terminalLayoutsByTabId = Object.fromEntries(
      panes.map((pane) => [
        pane.tabId,
        {
          root: { type: 'leaf' as const, leafId: pane.leafId },
          activeLeafId: pane.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [pane.leafId]: pane.ptyId }
        }
      ])
    )
    f.store.setWorkspaceSession(localSession, 'local')
    const tabs = panes.map((pane) => ({
      type: 'terminal' as const,
      id: `${pane.tabId}::${pane.leafId}`,
      parentTabId: pane.tabId,
      leafId: pane.leafId,
      ptyId: pane.ptyId,
      title: pane.tabId,
      isActive: false
    }))
    f.runtime.sync([
      {
        worktree: id,
        worktreeIdentity: owner,
        publicationEpoch: 'renderer:local',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs
      }
    ])
    for (const pane of panes) {
      f.runtime.registerOwnedLocalPane(pane.ptyId, pane.tabId, pane.leafId)
    }
    const retired = panes[0]!
    const survivor = panes[1]!
    expect(f.runtime.isRuntimeSessionOwned(retired.ptyId)).toBe(true)
    localSession.tabsByWorktree[id] = localSession.tabsByWorktree[id]!.filter(
      (tab) => tab.id !== retired.tabId
    )
    delete localSession.terminalLayoutsByTabId[retired.tabId]
    f.store.setWorkspaceSession(localSession, 'local')
    const current = f.runtime.current()
    if (!current) {
      throw new Error('Missing local publication')
    }
    f.runtime.sync([
      {
        ...current,
        publicationEpoch: 'renderer:local',
        snapshotVersion: current.snapshotVersion + 1,
        tabs: tabs.slice(1)
      }
    ])
    expect(f.runtime.current()?.tabs.map((tab) => tab.id)).toEqual([tabs[1]!.id])
    expect(f.runtime.isRuntimeSessionOwned(retired.ptyId)).toBe(false)
    expect(f.runtime.isRuntimeSessionOwned(survivor.ptyId)).toBe(true)
    f.runtime.rescue()
    expect(f.runtime.current()?.tabs.map((tab) => tab.id)).toEqual([tabs[1]!.id])
    expect(f.store.getWorkspaceSession('ssh:session-b')).toEqual(sshSession)
    expect(f.kill).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves dormant saved B panes in a same-owner renderer omission, reversed:%s',
    async (reversed) => {
      const f = createSessionOwnerFixture(reversed)
      const savedB = f.store.getWorkspaceSession('ssh:session-b')
      savedB.tabsByWorktree[id] = savedB.tabsByWorktree[id]!.map((tab) => ({
        ...tab,
        ptyId: toAppSshPtyId('session-b', `saved-${tab.id}`)
      }))
      f.store.setWorkspaceSession(savedB, 'ssh:session-b')
      await f.list('b')
      const b = f.runtime.current()
      if (!b) {
        throw new Error('Missing B publication')
      }
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SSH_PANE_RECOVERY_GRACE_MS + 1)
      f.runtime.sync([{ ...b, publicationEpoch: 'renderer:checked-b', snapshotVersion: 1 }])
      f.runtime.sync([
        {
          ...b,
          publicationEpoch: 'renderer:checked-b',
          snapshotVersion: 2,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ])
      expect(f.runtime.current()).toMatchObject({
        worktreeIdentity: f.identity('b'),
        tabs: [
          expect.objectContaining({ parentTabId: 'tab-b-1' }),
          expect.objectContaining({ parentTabId: 'tab-b-2' })
        ]
      })
      expect(f.store.getWorkspaceSession('ssh:session-b').tabsByWorktree[id]).toEqual(
        savedB.tabsByWorktree[id]
      )
      expect(
        f.store.getWorkspaceSession('ssh:session-a').tabsByWorktree[id]?.map((tab) => tab.id)
      ).toEqual(['tab-a-1', 'tab-a-2'])
      expect(f.kill).not.toHaveBeenCalled()
    }
  )
})
