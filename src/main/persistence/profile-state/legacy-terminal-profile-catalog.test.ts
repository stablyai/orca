import { getDefaultPersistedState } from '../../../shared/constants'
import { transferOrcaProfileProject } from '../../orca-profiles/profile-project-transfer'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { writeFileSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  open,
  nestedProfiles,
  holdCatalogReply,
  readState
} from './profile-state-live-store-test-fixture'
import { createProfileStateStore } from './profile-state-store-factory'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import { getOrcaProfileIndexPath } from '../../orca-profiles/profile-storage-paths'
import { tabId, leafId, workspace } from '../loading-store/legacy-pty-restore-test-fixture'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { projectProfileTerminalClaims } from './profile-state-terminal-claim-projection'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

async function inactive(root: string, profileId: string, numbered: boolean) {
  const { store } = createProfileStateStore({
    userDataPath: root,
    profileId,
    dataFile: getOrcaProfileDataFile(profileId, root),
    databaseFile: getOrcaProfileStateDatabaseFile(profileId, root)
  })
  if (numbered) {
    await store.admitTerminalPane({ type: 'createTerminalTab', workspace, tabId, leafId })
    await store.persistPtyBinding({
      worktreeId: workspace,
      tabId,
      leafId,
      ptyId: '9',
      mayCreate: false
    })
  } else {
    await store.applyLayoutCommand({ type: 'closePane', workspace, tabId, leafId })
  }
  store.flushOrThrow()
  store.freezeWrites()
}
const unique = (store: Awaited<ReturnType<typeof open>>['store']) =>
  store.legacyTerminalIdentityAuthority.unique(workspace, makePaneKey(tabId, leafId), '9')
const ready = (store: Awaited<ReturnType<typeof open>>['store']) =>
  store.legacyTerminalIdentityAuthority.captureExternalCatalog().ready

describe('root-wide legacy terminal catalog', () => {
  it.each([3, 30])(
    'reads %i real inactive snapshots once, then only the changed profile and no scalar saves',
    async (count) => {
      const { root, input, ids } = await nestedProfiles(count)
      const read = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'readTerminalClaims')
      const { store } = await open(input)
      expect(await ready(store)).toBe(true)
      expect(unique(store)).toBe(true)
      expect(read.mock.calls.map(([request]) => request.profileId)).toEqual(ids.slice(1))
      store.updateSettings({ theme: 'light' })
      await store.writeLatestProfileStateJsonExportAsync()
      expect(readState(input).settings.theme).toBe('light')
      expect(read).toHaveBeenCalledTimes(count)
      const finish = store.beginLegacyTerminalProfileChange()
      await inactive(root, ids[1], true)
      finish([ids[1]])
      expect(await ready(store)).toBe(true)
      expect(unique(store)).toBe(false)
      expect(read.mock.calls.map(([request]) => request.profileId)).toEqual([
        ...ids.slice(1),
        ids[1]
      ])
    }
  )

  it('discards a whole superseded batch before admitting any competing number', async () => {
    const { root, input } = await nestedProfiles(2)
    await inactive(root, 'inactive-0', true)
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const superseded = ready(store)
      await held.started
      const finish = store.beginLegacyTerminalProfileChange()
      await inactive(root, 'inactive-0', false)
      finish(['inactive-0'])
      expect(await superseded).toBe(false)
      held.gate.resolve()
      expect(await ready(store)).toBe(true)
      expect(unique(store)).toBe(true)
    } finally {
      held.gate.resolve()
    }
  })

  it('keeps the current epoch fenced across a real inactive-to-inactive project move', async () => {
    const { root, input } = await nestedProfiles(2)
    await inactive(root, 'inactive-0', true)
    const target = new ProfileStateSqliteAuthority(
      getOrcaProfileStateDatabaseFile('inactive-1', root),
      'inactive-1'
    )
    target.readSerializedState()
    target.writeSerializedState(Buffer.from(JSON.stringify(getDefaultPersistedState(root))))
    target.close()
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const old = ready(store)
      await held.started
      const finish = store.beginLegacyTerminalProfileChange()
      try {
        const moved = transferOrcaProfileProject(
          {
            sourceProfileId: 'inactive-0',
            targetProfileId: 'inactive-1',
            repoId: 'repo-local',
            mode: 'move'
          },
          root
        )
        expect(moved.status).toBe('transferred')
      } finally {
        finish()
      }
      expect(await old).toBe(false)
      held.gate.resolve()
      expect(await ready(store)).toBe(true)
      expect(unique(store)).toBe(false)
      const source = readState({
        ...input,
        profileId: 'inactive-0',
        databaseFile: getOrcaProfileStateDatabaseFile('inactive-0', root)
      })
      const destination = readState({
        ...input,
        profileId: 'inactive-1',
        databaseFile: getOrcaProfileStateDatabaseFile('inactive-1', root)
      })
      expect(source.workspaceSession.tabsByWorktree[workspace]).toBeUndefined()
      expect(
        destination.workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      ).toBe('9')
    } finally {
      held.gate.resolve()
    }
  })

  it('excludes the actual active database even when the index points at another profile', async () => {
    const { root, input } = await nestedProfiles()
    const index = JSON.parse(readFileSync(getOrcaProfileIndexPath(root), 'utf8'))
    index.activeProfileId = 'inactive-0'
    writeFileSync(getOrcaProfileIndexPath(root), JSON.stringify(index))
    const read = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'readTerminalClaims')
    const { store } = await open(input)
    expect(await ready(store)).toBe(true)
    expect(unique(store)).toBe(true)
    expect(read.mock.calls.map(([request]) => request.profileId)).toEqual(['inactive-0'])
  })

  it('keeps retained membership despite damaged presentation and orders a queued save after the actual reply', async () => {
    const { root, input } = await nestedProfiles()
    await inactive(root, 'inactive-0', true)
    const index = JSON.parse(readFileSync(getOrcaProfileIndexPath(root), 'utf8'))
    index.profiles[1].name = { damaged: true }
    writeFileSync(getOrcaProfileIndexPath(root), JSON.stringify(index))
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      await held.started
      store.updateSettings({ theme: 'light' })
      const saved = store.writeLatestProfileStateJsonExportAsync()
      const writes = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'writeSerializedDomains')
      expect(writes).not.toHaveBeenCalled()
      held.gate.resolve()
      await saved
      expect(await ready(store)).toBe(true)
      expect(unique(store)).toBe(false)
      expect(readState(input).settings.theme).toBe('light')
    } finally {
      held.gate.resolve()
    }
  })

  it('treats a corrupt inactive authority as unknown while the active writer keeps saving', async () => {
    const { root, input } = await nestedProfiles()
    writeFileSync(getOrcaProfileStateDatabaseFile('inactive-0', root), 'broken database')
    const { store } = await open(input)
    expect(await ready(store)).toBe(false)
    expect(unique(store)).toBe(false)
    store.updateSettings({ theme: 'light' })
    await store.writeLatestProfileStateJsonExportAsync()
    expect(readState(input).settings.theme).toBe('light')
    const finish = store.beginLegacyTerminalProfileChange()
    finish([])
    expect(await ready(store)).toBe(false)
    store.updateSettings({ theme: 'dark' })
    await store.writeLatestProfileStateJsonExportAsync()
    expect(readState(input).settings.theme).toBe('dark')
  })

  it('keeps maintenance behind the real catalog reply and refreshes only after writer resume', async () => {
    const { input } = await nestedProfiles()
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const original = ready(store)
      await held.started
      const closes = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'close')
      const pending = store.beginProfileMaintenance()
      expect(await original).toBe(false)
      expect(closes).not.toHaveBeenCalled()
      held.gate.resolve()
      const maintenance = await pending
      await maintenance.resume()
      expect(await ready(store)).toBe(true)
      expect(unique(store)).toBe(true)
      store.updateSettings({ theme: 'light' })
      await store.writeLatestProfileStateJsonExportAsync()
      expect(readState(input).settings.theme).toBe('light')
    } finally {
      held.gate.resolve()
    }
  })

  it('classifies folder inheritance and host partitions with the same negative-claim rules', () => {
    const projected = projectProfileTerminalClaims(
      new Map<string, unknown>([
        ['repos', []],
        [
          'projectGroups',
          [
            { id: 'remote', parentGroupId: null, executionHostId: 'ssh:host' },
            { id: 'local', parentGroupId: null }
          ]
        ],
        [
          'folderWorkspaces',
          [
            { id: 'f', folderPath: '/remote', projectGroupId: 'remote' },
            { id: 'l', folderPath: '/local', projectGroupId: 'local' }
          ]
        ],
        [
          'workspaceSession',
          {
            tabsByWorktree: {
              'folder:f': [{ id: 'remote-tab', ptyId: '8' }],
              'folder:l': [{ id: 'local-tab', ptyId: '9' }]
            }
          }
        ],
        [
          'workspaceSessionsByHostId',
          {
            'ssh:host': { tabsByWorktree: { unknown: [{ id: 'r', ptyId: '6' }] } },
            local: { tabsByWorktree: { unknown: [{ id: 'u', ptyId: '7' }] } }
          }
        ]
      ])
    )
    expect(projected).toEqual(['9', '7'])
  })
})
