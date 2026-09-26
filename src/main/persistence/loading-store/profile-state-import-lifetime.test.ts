import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import {
  clearMigrationUnsupportedPty,
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyPersistenceListener
} from '../../agent-hooks/migration-unsupported-pty-state'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import * as composition from './store-domain-composition'
import { scheduleSave } from './write-scheduling'
import { Store } from './store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []
const stores: Store[] = []
const livePaneKey = 'live-tab:11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  agentHookServer.setPaneKeyAliasPersistenceListener(null)
  setMigrationUnsupportedPtyPersistenceListener(null)
  agentHookServer.clearPaneKeyAliasesForPty('later-live-pty')
  clearMigrationUnsupportedPty('later-live-pty')
  for (const store of stores.splice(0)) {
    await store.freezeWritesAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([false, true])('isolates imported aliases and live listeners (load failure=%s)', (fail) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const directory = mkdtempSync(join(tmpdir(), 'orca-import-lifetime-'))
  directories.push(directory)
  const live = new Store({ dataFile: join(directory, 'live', 'orca-data.json') })
  stores.push(live)
  const source = buildProfileStateCutoverFixture(directory)
  for (const session of [
    source.workspaceSession,
    ...Object.values(source.workspaceSessionsByHostId ?? {})
  ]) {
    if (!session) {
      continue
    }
    for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
      layout.root = { type: 'leaf', leafId: 'pane:1' }
      layout.activeLeafId = 'pane:1'
      layout.ptyIdsByLeafId = { 'pane:1': `imported-${tabId}` }
    }
  }
  const registerAlias = vi.spyOn(agentHookServer, 'registerPaneKeyAlias')
  const replaceListener = vi.spyOn(agentHookServer, 'setPaneKeyAliasPersistenceListener')
  if (fail) {
    const createDomains = composition.createStoreDomains
    vi.spyOn(composition, 'createStoreDomains').mockImplementationOnce((runtime) => {
      const domains = createDomains(runtime)
      vi.spyOn(domains.adaptation, 'hydrateFolderWorkspaceDiffComments').mockImplementationOnce(
        () => {
          scheduleSave(domains.scheduling)
          throw new Error('normalization refused')
        }
      )
      return domains
    })
  }
  const pendingTimers = vi.getTimerCount()
  const createImport = () =>
    new Store({
      dataFile: join(directory, 'imported', 'orca-data.json'),
      serializedState: JSON.stringify(source)
    })
  if (fail) {
    expect(createImport).toThrow('normalization refused')
  } else {
    const imported = createImport()
    stores.push(imported)
    expect(JSON.parse(imported.prepareProfileStateExport().json).legacyPaneKeyAliasEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ legacyPaneKey: 'tab-local:1', ptyId: 'imported-tab-local' }),
        expect.objectContaining({ legacyPaneKey: 'tab-remote:1', ptyId: 'imported-tab-remote' })
      ])
    )
  }
  expect(registerAlias).not.toHaveBeenCalled()
  expect(replaceListener).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(pendingTimers)
  agentHookServer.registerPaneKeyAlias('live-tab:1', livePaneKey, 'later-live-pty')
  setMigrationUnsupportedPty({
    ptyId: 'later-live-pty',
    paneKey: livePaneKey,
    tabId: 'live-tab',
    worktreeId: 'live-worktree',
    reason: 'legacy-numeric-pane-key',
    source: 'local',
    updatedAt: 1
  })
  const persisted = JSON.parse(live.prepareProfileStateExport().json)
  expect(persisted.legacyPaneKeyAliasEntries).toEqual([
    expect.objectContaining({ legacyPaneKey: 'live-tab:1', ptyId: 'later-live-pty' })
  ])
  expect(persisted.migrationUnsupportedPtyEntries).toEqual([
    expect.objectContaining({ ptyId: 'later-live-pty', paneKey: livePaneKey })
  ])
})
