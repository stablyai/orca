import { sharedPromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createProfileStateStore } from './profile-state-store-factory'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import {
  restoreFixtureForStore,
  tabId,
  leafId,
  workspace,
  paneKey
} from '../loading-store/legacy-pty-restore-test-fixture'
import { peekDaemonHistoryRoot } from '../../daemon/launch/daemon-launch-paths'
import { hasExclusiveOrcadInstanceLock } from '../../orcad/orcad-instance-lock-hold'
import { installedRestore } from '../loading-store/legacy-pty-runtime-restore-test-fixture'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './legacy-json/profile-state-export-path'
import {
  options,
  open,
  nestedProfiles,
  holdCatalogReply,
  readState,
  stores
} from './profile-state-live-store-test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('live profile authority admission', () => {
  it.each(['sync', 'worker'] as const)(
    'restores a numbered pane from nested profile storage through the %s factory',
    async (factory) => {
      const base = options()
      const root = dirname(base.dataFile)
      const input = {
        userDataPath: root,
        profileId: 'local-default',
        dataFile: getOrcaProfileDataFile('local-default', root),
        databaseFile: getOrcaProfileStateDatabaseFile('local-default', root)
      }
      mkdirSync(dirname(input.dataFile), { recursive: true })
      writeFileSync(input.dataFile, JSON.stringify(buildProfileStateCutoverFixture(root)))
      const { store } = factory === 'worker' ? await open(input) : createProfileStateStore(input)
      if (factory === 'sync') {
        stores.push(store)
      }
      const f = await restoreFixtureForStore(store, root)
      const before = readFileSync(join(root, 'terminal-history/9/checkpoint.json'))
      if (process.platform === 'win32' && factory === 'sync') {
        const paths = {
          raw: root,
          sync: realpathSync(root),
          native: realpathSync.native(root),
          promise: await realpath(root)
        }
        const receipts = Object.fromEntries(
          Object.entries(paths).map(([kind, path]) => [kind, hasExclusiveOrcadInstanceLock(path)])
        )
        const authority = peekDaemonHistoryRoot()!
        const begin = authority.beginMigration.bind(authority)
        vi.spyOn(authority, 'beginMigration').mockImplementation(async (...args) => {
          const lease = await begin(...args)
          console.info(
            JSON.stringify({
              contract: 'native-terminal-root',
              paths,
              receipts,
              associated: authority.matchesProfile(
                store.legacyTerminalIdentityAuthority.canonicalProfile
              ),
              unique: store.legacyTerminalIdentityAuthority.unique(workspace, paneKey, '9'),
              complete: store.legacyTerminalIdentityAuthority.captureExternalCatalog().complete,
              lease: lease?.current() ?? false
            })
          )
          return lease
        })
      }
      const { runtime, create } = installedRestore(f)
      const created = await create()
      expect(created.ptyId).toBe('repo-local::/fixture/local@@e2fec859')
      expect(f.seen).toEqual([
        { id: '9', attachOnly: true },
        { id: 'repo-local::/fixture/local@@e2fec859', attachOnly: false }
      ])
      expect(
        readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      ).toBe('repo-local::/fixture/local@@e2fec859')
      const screen = await runtime.serializeMainTerminalBuffer(created.ptyId!, {
        scrollbackRows: 100
      })
      expect(screen?.data).toContain('old terminal screen')
      expect(readFileSync(join(root, 'terminal-history/9/checkpoint.json')).equals(before)).toBe(
        true
      )
      expect(
        readFileSync(
          join(root, 'terminal-history', encodeURIComponent(created.ptyId!), 'checkpoint.json')
        ).equals(before)
      ).toBe(true)
      await runtime.onPtyExit(created.ptyId!, 0, `incarnation-${created.ptyId}`, {
        providerExitObserved: true
      })
    }
  )

  it.each(['foreign', 'omitted'] as const)(
    'preserves the numbered pane when its terminal root association is %s',
    async (association) => {
      const base = options()
      const root = dirname(base.dataFile)
      const foreign = join(root, 'different-user-data')
      mkdirSync(foreign)
      const input = {
        ...(association === 'foreign' ? { userDataPath: foreign } : {}),
        profileId: 'local-default',
        dataFile: getOrcaProfileDataFile('local-default', root),
        databaseFile: getOrcaProfileStateDatabaseFile('local-default', root)
      }
      mkdirSync(dirname(input.dataFile), { recursive: true })
      writeFileSync(input.dataFile, JSON.stringify(buildProfileStateCutoverFixture(root)))
      const { store } = createProfileStateStore(input)
      stores.push(store)
      const f = await restoreFixtureForStore(store, root)
      const before = readFileSync(join(root, 'terminal-history/9/checkpoint.json'))
      const { runtime, create } = installedRestore(f)
      const created = await create()
      expect(created.ptyId).toBe('9')
      expect(f.seen).toEqual([
        { id: '9', attachOnly: true },
        { id: '9', attachOnly: false }
      ])
      expect(created.savedStartupCwd).toBe('/fixture/local')
      expect(
        readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      ).toBe('9')
      expect(
        existsSync(
          join(root, 'terminal-history', encodeURIComponent('repo-local::/fixture/local@@e2fec859'))
        )
      ).toBe(false)
      const screen = await runtime.serializeMainTerminalBuffer('9', { scrollbackRows: 100 })
      expect(screen?.data).toContain('old terminal screen')
      expect(readFileSync(join(root, 'terminal-history/9/checkpoint.json')).equals(before)).toBe(
        true
      )
      await runtime.onPtyExit('9', 0, 'incarnation-9', { providerExitObserved: true })
    }
  )

  it('waits for the initial real inactive-profile reply and converts that same installed restore', async () => {
    const { root, input } = await nestedProfiles()
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const f = await restoreFixtureForStore(store, root)
      const before = readFileSync(join(root, 'terminal-history/9/checkpoint.json'))
      const { runtime, create } = installedRestore(f)
      const epoch = store.legacyTerminalIdentityAuthority.captureExternalCatalog()
      const pending = create()
      await held.started
      await expect.poll(() => sharedPromiseSettlementWaiters(epoch.ready).waiterCount).toBe(1)
      expect(f.seen).toEqual([])
      held.gate.resolve()
      const created = await pending
      expect(created.ptyId).toBe('repo-local::/fixture/local@@e2fec859')
      expect(
        (await runtime.serializeMainTerminalBuffer(created.ptyId!, { scrollbackRows: 100 }))?.data
      ).toContain('old terminal screen')
      expect(
        readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      ).toBe('repo-local::/fixture/local@@e2fec859')
      expect(readFileSync(join(root, 'terminal-history/9/checkpoint.json')).equals(before)).toBe(
        true
      )
      await runtime.onPtyExit(created.ptyId!, 0, `incarnation-${created.ptyId}`, {
        providerExitObserved: true
      })
    } finally {
      held.gate.resolve()
    }
  })

  it('keeps ambiguous numbered history in its installed original pane without migrating either claimant', async () => {
    const { root, input } = await nestedProfiles(0)
    const { store } = await open(input)
    const f = await restoreFixtureForStore(store, root)
    await f.addLegacyPeer()
    const before = readFileSync(join(root, 'terminal-history/9/checkpoint.json'))
    const { runtime, create } = installedRestore(f)
    const created = await create()
    expect(created.ptyId).toBe('9')
    expect(f.seen).toEqual([
      { id: '9', attachOnly: true },
      { id: '9', attachOnly: false }
    ])
    expect(
      (await runtime.serializeMainTerminalBuffer('9', { scrollbackRows: 100 }))?.data
    ).toContain('old terminal screen')
    expect(
      readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    ).toBe('9')
    expect(store.getWorkspaceSession().tabsByWorktree['peer::/other'][0].ptyId).toBe('9')
    expect(
      existsSync(
        join(root, 'terminal-history', encodeURIComponent('repo-local::/fixture/local@@e2fec859'))
      )
    ).toBe(false)
    expect(readFileSync(join(root, 'terminal-history/9/checkpoint.json')).equals(before)).toBe(true)
    await f.close()
    expect(f.provider.killFenced).not.toHaveBeenCalled()
    await runtime.onPtyExit('9', 0, 'incarnation-9', { providerExitObserved: true })
  })

  it('never adopts a competing revision between bootstrap and worker readiness', async () => {
    const input = options()
    const original = ProfileStateSqliteAuthority.prototype.retireForWorker
    vi.spyOn(ProfileStateSqliteAuthority.prototype, 'retireForWorker').mockImplementation(function (
      this: ProfileStateSqliteAuthority
    ) {
      const handoff = original.call(this)
      const peer = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
      try {
        peer.readSerializedState()
        peer.writeSerializedDomains([{ domain: 'peer', payload: '{"retained":true}' }])
      } finally {
        peer.close()
      }
      return handoff
    })
    await expect(open(input)).rejects.toThrow('Profile state revision changed')
    expect(readState(input).peer).toEqual({ retained: true })
  })

  it('orders exports with full checkpoints and closes backup and writer handles on final flush', async () => {
    const input = options()
    const { store } = await open(input)
    store.getWorkspaceSession().activeTabId = 'getter-export'
    store.updateSettings({ theme: 'dark' })
    const revision = await store.writeLatestProfileStateJsonExportAsync()
    expect(revision).toBeTypeOf('number')
    if (revision === undefined) {
      throw new Error('Expected a persisted profile revision')
    }
    expect(
      JSON.parse(readFileSync(profileStateJsonExportPath(input.dataFile, revision), 'utf8'))
        .workspaceSession.activeTabId
    ).toBe('getter-export')
    const retainedExports = profileStateJsonExportPaths(input.dataFile)
    store.updateSettings({ theme: 'light' })
    await store.flushFinalOrThrowAsync()
    expect(existsSync(input.dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(input.dataFile)).toEqual(retainedExports)
    expect(profileStateJsonExportPaths(input.dataFile).length).toBeGreaterThan(0)
    expect(readState(input).settings.theme).toBe('light')
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    const reopened = await open(input)
    expect(reopened.store.getSettings().theme).toBe('light')
  })
})
