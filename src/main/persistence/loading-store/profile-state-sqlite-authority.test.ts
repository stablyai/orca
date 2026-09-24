import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_AUTOMATION_RUNS_PER_AUTOMATION } from '../../../shared/automation-run-retention'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import {
  profileStateJsonMatchesAcceptance,
  exportProfileStateJson,
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateJsonAcceptance,
  readProfileStateSnapshot
} from '../profile-state/profile-state-documents'
import { parseProfileStateRoot } from '../profile-state/profile-state-document-validation'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../profile-state/profile-state-database'
import { profileStateJsonExportPath } from '../profile-state/profile-state-export-path'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

const { Store } = await import('./store')
const { createProfileStateStore } = await import('../profile-state/profile-state-store-factory')

const temporaryDirectories: string[] = []
const backupAuthorities = new Set<ProfileStateSqliteAuthority>()
const authorities = new Set<ProfileStateSqliteAuthority>()
const scheduleBackup = ProfileStateSqliteAuthority.prototype.scheduleBackup

function createAuthority(databasePath: string, profileId: string): ProfileStateSqliteAuthority {
  const authority = new ProfileStateSqliteAuthority(databasePath, profileId)
  authorities.add(authority)
  return authority
}

beforeEach(() => {
  vi.spyOn(ProfileStateSqliteAuthority.prototype, 'scheduleBackup').mockImplementation(
    function (this: ProfileStateSqliteAuthority) {
      backupAuthorities.add(this)
      scheduleBackup.call(this)
    }
  )
})

afterEach(async () => {
  for (const authority of authorities) {
    authority.close()
    await authority.drainBackups()
  }
  authorities.clear()
  backupAuthorities.clear()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('Store with an injected SQLite profile-state authority', () => {
  it('rejects profile-state buffers that are not valid UTF-8', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-invalid-utf8-'))
    temporaryDirectories.push(directory)
    const authority = createAuthority(join(directory, 'profile-state.db'), 'profile-authority-test')

    authority.writeSerializedState(Buffer.from('{"settings":{"theme":"dark"}}'))
    const before = authority.readSerializedState()
    const malformed = Buffer.concat([
      Buffer.from('{"settings":{"theme":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}')
    ])
    expect(() => authority.writeSerializedState(malformed)).toThrow(
      'Profile state payload is not valid UTF-8'
    )
    expect(authority.readSerializedState()).toBe(before)
    authority.close()
  })

  it('mutates, flushes, and reloads without writing the legacy JSON file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = join(directory, 'profile-state.db')
    writeFileSync(dataFile, '{"settings":{"theme":"light"}}', 'utf8')
    const legacyBytes = readFileSync(dataFile)
    const authority = createAuthority(databaseFile, 'profile-authority-test')

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark', opencodeSessionCookie: 'authority-secret' })
    store.flushOrThrow()

    store.updateSettings({ terminalFontSize: store.getSettings().terminalFontSize + 1 })
    await store.flushPendingOrThrowAsync()

    expect(readFileSync(dataFile)).toEqual(legacyBytes)
    expect(existsSync(databaseFile)).toBe(true)

    const reloaded = new Store({ dataFile, profileStateAuthority: authority })
    expect(reloaded.getSettings().theme).toBe('dark')
    expect(reloaded.getSettings().terminalFontSize).toBe(store.getSettings().terminalFontSize)
    expect(reloaded.getSettings().opencodeSessionCookie).toBe('authority-secret')
    expect(readFileSync(dataFile)).toEqual(legacyBytes)
    reloaded.freezeWrites()
  })

  it('rejects a corrupt ordering placeholder when normalized rows exist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-normalized-read-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const fixture = buildProfileStateCutoverFixture()
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify(fixture)))
    authority.close()

    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    opened.db
      .prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?')
      .run('{invalid', 'automationRuns')
    opened.db.close()

    const runtime = createAuthority(databasePath, 'profile-authority-test')
    expect(() => runtime.readSerializedState()).toThrow(/hash mismatch: automationRuns/)
    runtime.close()

    const strict = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      expect(() => readProfileStateSnapshot(strict.db)).toThrow(/hash mismatch: automationRuns/)
    } finally {
      strict.db.close()
    }
  })

  it('rejects invalid domain JSON before handing it to the Store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-runtime-parse-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))
    authority.close()

    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    opened.db
      .prepare('UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?')
      .run('{invalid', hashProfileStateJson('{invalid'), 'settings')
    opened.db.close()

    expect(
      () =>
        new Store({
          dataFile: join(directory, 'orca-data.json'),
          profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
        })
    ).toThrow('Profile state document payload is invalid JSON: settings')
  })

  it('rejects documents whose revision metadata was removed or reset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' } }))
    opened.db.prepare("DELETE FROM profile_state_meta WHERE key = 'revision'").run()
    opened.db.close()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    expect(() => authority.readSerializedState()).toThrow()
  })

  it('fences a complete-document writer that read before another authority committed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-cas-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const first = createAuthority(databasePath, 'profile-authority-test')
    const second = createAuthority(databasePath, 'profile-authority-test')

    first.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'light' } })))
    expect(second.readSerializedState()).toBe(JSON.stringify({ settings: { theme: 'light' } }))

    first.readSerializedState()
    first.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))
    expect(() =>
      second.writeSerializedState(
        Buffer.from(JSON.stringify({ settings: { theme: 'stale-writer' } }))
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'profile-state-revision-conflict',
        expectedRevision: 1,
        actualRevision: 2
      })
    )

    const verifier = createAuthority(databasePath, 'profile-authority-test')
    expect(verifier.readSerializedState()).toBe(JSON.stringify({ settings: { theme: 'dark' } }))
  })

  it('fences a first commit after another authority creates the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-create-cas-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const first = createAuthority(databasePath, 'profile-authority-test')
    const second = createAuthority(databasePath, 'profile-authority-test')

    expect(first.readSerializedState()).toBeUndefined()
    second.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'other' } })))

    expect(() =>
      first.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'stale' } })))
    ).toThrowError(
      expect.objectContaining({
        code: 'profile-state-revision-conflict',
        expectedRevision: 0,
        actualRevision: 1
      })
    )
  })

  it('keeps normalized rows stable during a complete document replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-complete-write-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const fixture = buildProfileStateCutoverFixture(directory)
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify(fixture)))

    const before = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    const beforeAutomationMeta = before.db
      .prepare(
        'SELECT revision, content_hash FROM profile_state_automation_runs_meta WHERE domain = ?'
      )
      .get('automationRuns')
    const beforeAutomationRows = before.db
      .prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs')
      .get()
    before.db.close()

    const replacement = parseProfileStateRoot(authority.readSerializedState() ?? '{}')
    replacement.settings = { theme: 'complete-replacement' }
    replacement.unknownDomain = { preserved: true }
    delete replacement.ui
    authority.writeSerializedState(Buffer.from(JSON.stringify(replacement)))

    expect(JSON.parse(authority.readSerializedState() ?? '{}')).toMatchObject({
      settings: { theme: 'complete-replacement' },
      unknownDomain: { preserved: true }
    })
    const after = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      expect(
        after.db.prepare('SELECT value FROM profile_state_meta WHERE key = ?').get('revision')
      ).toEqual({ value: '2' })
      expect(
        after.db
          .prepare(
            'SELECT revision, content_hash FROM profile_state_automation_runs_meta WHERE domain = ?'
          )
          .get('automationRuns')
      ).toEqual(beforeAutomationMeta)
      expect(
        after.db.prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs').get()
      ).toEqual(beforeAutomationRows)
      expect(
        after.db.prepare('SELECT 1 FROM profile_state_documents WHERE domain = ?').get('ui')
      ).toBe(undefined)
    } finally {
      after.db.close()
    }
  })

  it('reopens its writer after an explicit close without losing the revision fence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-authority-close-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')

    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'light' } })))
    authority.close()
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))

    const verifier = createAuthority(databasePath, 'profile-authority-test')
    expect(verifier.readSerializedState()).toBe(JSON.stringify({ settings: { theme: 'dark' } }))
    verifier.close()
  })

  it('keeps a newer Store commit when a stale Store flushes afterward', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-store-cas-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'light' } })))

    const first = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    const stale = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    const initialTerminalFontSize = first.getSettings().terminalFontSize
    first.updateSettings({ theme: 'dark' })
    first.flushOrThrow()

    stale.updateSettings({ terminalFontSize: stale.getSettings().terminalFontSize + 1 })
    expect(() => stale.flushOrThrow()).toThrowError(
      expect.objectContaining({
        code: 'profile-state-revision-conflict',
        expectedRevision: 1,
        actualRevision: 2
      })
    )

    const verifier = createAuthority(databasePath, 'profile-authority-test')
    expect(JSON.parse(verifier.readSerializedState() ?? '{}')).toMatchObject({
      settings: { theme: 'dark', terminalFontSize: initialTerminalFontSize }
    })
  })

  it('writes a local session mutation as dirty domains and preserves unrelated rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-domain-write-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const seedDataFile = join(directory, 'seed-orca-data.json')
    const seedStore = new Store({ dataFile: seedDataFile })
    seedStore.updateSettings({ theme: 'light' })
    seedStore.flushOrThrow()
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(readFileSync(seedDataFile))
    seedStore.freezeWrites()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    const writeDomains = vi.spyOn(authority, 'writeSerializedDomains')
    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.flushOrThrow()
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      activeTabId: 'after'
    })
    store.flushOrThrow()

    expect(writeDomains).toHaveBeenCalledTimes(1)
    expect(writeDomains.mock.calls[0]?.[0].map(({ domain }) => domain)).toEqual([
      'workspaceSession'
    ])
    const reloaded = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    expect(reloaded.getWorkspaceSession().activeTabId).toBe('after')
    expect(reloaded.getSettings().theme).toBe('light')
    reloaded.freezeWrites()
  })

  it('writes a PTY rebind through the workspace-session domain', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-pty-domain-write-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const fixtureFile = join(directory, 'fixture-orca-data.json')
    writeFileSync(fixtureFile, JSON.stringify(buildProfileStateCutoverFixture(directory)))
    const seedStore = new Store({ dataFile: fixtureFile })
    seedStore.flushOrThrow()
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(readFileSync(fixtureFile))
    seedStore.freezeWrites()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    const writeDomains = vi.spyOn(authority, 'writeSerializedDomains')
    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.flushOrThrow()
    const session = store.getWorkspaceSession()
    const worktreeId = session.activeWorktreeId
    const tabId = session.activeTabId
    const layout = tabId ? session.terminalLayoutsByTabId[tabId] : undefined
    const leafId = layout ? Object.keys(layout.ptyIdsByLeafId ?? {})[0] : undefined
    const previousPtyId = leafId ? layout?.ptyIdsByLeafId?.[leafId] : undefined
    if (!worktreeId || !tabId || !layout || !leafId || !previousPtyId) {
      throw new Error('fixture did not produce a normalized PTY binding')
    }

    expect(
      await store.persistPtyBinding({
        worktreeId,
        tabId,
        leafId,
        ptyId: 'pty-rebound',
        expectedBinding: { ptyId: previousPtyId }
      })
    ).toBe(true)
    expect(writeDomains).toHaveBeenCalledTimes(1)
    expect(writeDomains.mock.calls[0]?.[0].map(({ domain }) => domain)).toEqual([
      'workspaceSession'
    ])

    const remoteSession = store.getWorkspaceSession('ssh:build-host')
    const remoteWorktreeId = remoteSession.activeWorktreeId
    const remoteTabId = remoteSession.activeTabId
    const remoteLayout = remoteTabId ? remoteSession.terminalLayoutsByTabId[remoteTabId] : undefined
    const remoteLeafId = remoteLayout
      ? Object.keys(remoteLayout.ptyIdsByLeafId ?? {})[0]
      : undefined
    const remotePtyId = remoteLeafId ? remoteLayout?.ptyIdsByLeafId?.[remoteLeafId] : undefined
    if (!remoteWorktreeId || !remoteTabId || !remoteLayout || !remoteLeafId || !remotePtyId) {
      throw new Error('fixture did not produce a normalized remote PTY binding')
    }
    expect(
      await store.persistPtyBinding(
        {
          worktreeId: remoteWorktreeId,
          tabId: remoteTabId,
          leafId: remoteLeafId,
          ptyId: 'pty-remote-rebound',
          expectedBinding: { ptyId: remotePtyId }
        },
        'ssh:build-host'
      )
    ).toBe(true)
    expect(writeDomains).toHaveBeenCalledTimes(2)
    expect(writeDomains.mock.calls[1]?.[0].map(({ domain }) => domain)).toEqual([
      'workspaceSessionsByHostId'
    ])

    const reloaded = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    expect(
      reloaded.getWorkspaceSession().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId
    ).toMatchObject({
      [leafId]: 'pty-rebound'
    })
    reloaded.freezeWrites()
  })

  it('writes scheduled automation changes as automations and automationRuns domains', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-automation-write-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const seedDataFile = join(directory, 'seed-orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    writeFileSync(seedDataFile, JSON.stringify(buildProfileStateCutoverFixture(directory)))
    const seedStore = new Store({ dataFile: seedDataFile })
    seedStore.flushOrThrow()
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(readFileSync(seedDataFile))
    seedStore.freezeWrites()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    const writeAutomationRuns = vi.spyOn(authority, 'writeSerializedAutomationRuns')
    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.flushOrThrow()
    const automation = store.listAutomations()[0]
    if (!automation) {
      throw new Error('fixture automation missing')
    }
    store.createAutomationRun(automation, Date.now(), 'scheduled')

    expect(writeAutomationRuns).toHaveBeenCalledTimes(1)
    expect(writeAutomationRuns.mock.calls[0]?.[0].map(({ domain }) => domain)).toEqual([
      'automations'
    ])
    expect(writeAutomationRuns.mock.calls[0]?.[1]).toHaveLength(2)
    const reloaded = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    expect(reloaded.listAutomationRuns()).toHaveLength(2)
    reloaded.freezeWrites()
  })

  it('persists an automation run lifecycle through normalized rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-automation-lifecycle-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const seedDataFile = join(directory, 'seed-orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    writeFileSync(seedDataFile, JSON.stringify(buildProfileStateCutoverFixture(directory)))
    const seedStore = new Store({ dataFile: seedDataFile })
    seedStore.flushOrThrow()
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(readFileSync(seedDataFile))
    seedStore.freezeWrites()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    const writeAutomationRuns = vi.spyOn(authority, 'writeSerializedAutomationRuns')
    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.flushOrThrow()
    const automation = store.listAutomations()[0]
    if (!automation) {
      throw new Error('fixture automation missing')
    }

    store.updateUI({ browserKagiSessionLink: 'https://kagi.com/session?t=authority' })
    store.flushOrThrow()
    const pending = store.createAutomationRun(automation, 30, 'manual')
    store.flushOrThrow()
    expect(pending.status).toBe('pending')
    const completed = store.updateAutomationRun({
      runId: pending.id,
      status: 'completed',
      outputSnapshot: {
        format: 'plain_text',
        content: 'completed through sqlite',
        capturedAt: 31,
        truncated: false
      }
    })
    store.flushOrThrow()
    expect(completed.status).toBe('completed')
    expect(writeAutomationRuns).toHaveBeenCalledTimes(2)
    expect(writeAutomationRuns.mock.calls[1]?.[0].map(({ domain }) => domain)).toEqual([
      'automations'
    ])

    const reloaded = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    expect(reloaded.listAutomationRuns('automation-fixture')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pending.id,
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'completed through sqlite' })
        })
      ])
    )
    expect(reloaded.getUI().featureInteractions?.['automation-run']?.interactionCount).toBe(1)
    expect(reloaded.getUI().browserKagiSessionLink).toBe('https://kagi.com/session?t=authority')
    const stored = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      const uiRow = stored.db
        .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
        .get('ui')
      expect(uiRow).toEqual(
        expect.objectContaining({ payload: expect.not.stringContaining('authority') })
      )
    } finally {
      stored.db.close()
    }
    reloaded.freezeWrites()
  })

  it('prunes normalized automation rows and reloads the retained window', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-automation-retention-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const seedDataFile = join(directory, 'seed-orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    writeFileSync(seedDataFile, JSON.stringify(buildProfileStateCutoverFixture(directory)))
    const seedStore = new Store({ dataFile: seedDataFile })
    seedStore.flushOrThrow()
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(readFileSync(seedDataFile))
    seedStore.freezeWrites()

    const store = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    store.flushOrThrow()
    const automation = store.listAutomations()[0]
    if (!automation) {
      throw new Error('fixture automation missing')
    }
    for (let index = 0; index < MAX_AUTOMATION_RUNS_PER_AUTOMATION + 2; index += 1) {
      const run = store.createAutomationRun(automation, 100 + index, 'scheduled')
      store.updateAutomationRun({ runId: run.id, status: 'completed' })
    }

    const reloaded = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    const retained = reloaded.listAutomationRuns('automation-fixture')
    expect(retained).toHaveLength(MAX_AUTOMATION_RUNS_PER_AUTOMATION)
    expect(retained.some((run) => run.id === 'automation-run-fixture')).toBe(false)
    reloaded.flushOrThrow()
    const stored = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      expect(
        stored.db.prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs').get()
      ).toEqual({ count: MAX_AUTOMATION_RUNS_PER_AUTOMATION })
    } finally {
      stored.db.close()
    }
    reloaded.freezeWrites()
  })

  it('writes host-qualified worktree metadata as projected domain rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-worktree-write-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const seedDataFile = join(directory, 'seed-orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    writeFileSync(seedDataFile, JSON.stringify(buildProfileStateCutoverFixture(directory)))
    const seedStore = new Store({ dataFile: seedDataFile })
    seedStore.flushOrThrow()
    const seed = createAuthority(databasePath, 'profile-authority-test')
    seed.writeSerializedState(readFileSync(seedDataFile))
    seedStore.freezeWrites()

    const authority = createAuthority(databasePath, 'profile-authority-test')
    const writeDomains = vi.spyOn(authority, 'writeSerializedDomains')
    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.flushOrThrow()
    store.setWorktreeMetaForHost('repo-local::/fixture/local', 'local', {
      displayName: 'Updated fixture local'
    })
    store.flushOrThrow()

    expect(writeDomains).toHaveBeenCalledTimes(1)
    expect(writeDomains.mock.calls[0]?.[0].map(({ domain }) => domain)).toEqual(
      expect.arrayContaining(['worktreeMeta', 'worktreeMetaByIdentity', 'worktreeIdentityAliases'])
    )
    const reloaded = new Store({
      dataFile,
      profileStateAuthority: createAuthority(databasePath, 'profile-authority-test')
    })
    expect(
      reloaded.getWorktreeMetaForHost('repo-local::/fixture/local', 'local')?.displayName
    ).toBe('Updated fixture local')
    reloaded.freezeWrites()
  })

  it('publishes a durable JSON rollback export without changing the SQLite authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-json-export-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(
      Buffer.from(JSON.stringify({ settings: { theme: 'dark' }, unknownDomain: { keep: true } }))
    )

    const exportPath = join(directory, 'rollback', 'orca-data.json.r3')
    const revision = authority.writeJsonExport(exportPath)

    expect(revision).toBe(1)
    expect(JSON.parse(readFileSync(exportPath, 'utf8'))).toEqual({
      settings: { theme: 'dark' },
      unknownDomain: { keep: true }
    })
    const reopened = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      expect(exportProfileStateJson(reopened.db)).toBe(readFileSync(exportPath, 'utf8'))
    } finally {
      reopened.db.close()
    }
  })

  it('publishes the Store export after flushing pending SQLite state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-store-export-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const seed = new Store({ dataFile })
    seed.flushOrThrow()
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(seed.prepareProfileStateExport().json, 'utf8'))
    seed.freezeWrites()

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark' })
    const exportPath = join(directory, 'rollback', 'orca-data.json.current')
    const revision = store.writeProfileStateJsonExport(exportPath)

    expect(revision).toBe(2)
    expect(JSON.parse(readFileSync(exportPath, 'utf8')).settings.theme).toBe('dark')
    store.freezeWrites()
  })

  it('publishes the latest SQLite revision as an idempotent versioned export', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-latest-export-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const seed = new Store({ dataFile })
    seed.updateSettings({ theme: 'light' })
    seed.flushOrThrow()
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(seed.prepareProfileStateExport().json, 'utf8'))
    seed.freezeWrites()

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark' })

    const firstRevision = store.writeLatestProfileStateJsonExport()
    expect(firstRevision).toBe(2)
    if (firstRevision === undefined) {
      throw new Error('Expected the SQLite authority to publish a revisioned export')
    }
    const firstPath = profileStateJsonExportPath(dataFile, firstRevision)
    expect(JSON.parse(readFileSync(firstPath, 'utf8')).settings.theme).toBe('dark')

    expect(store.writeLatestProfileStateJsonExport()).toBe(firstRevision)
    expect(readFileSync(profileStateJsonExportPath(dataFile, 2), 'utf8')).toBe(
      readFileSync(firstPath, 'utf8')
    )
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith('orca-data.json.sqlite-export.pending.')
      )
    ).toBe(false)
    store.freezeWrites()
  })

  it('publishes canonical JSON for an older build and advances its acceptance marker', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-compat-export-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const seed = new Store({ dataFile })
    seed.updateSettings({ theme: 'light' })
    seed.flushOrThrow()
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(seed.prepareProfileStateExport().json, 'utf8'))
    seed.freezeWrites()

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark' })
    const revision = store.writeLatestProfileStateJsonCompatibilityExport()

    expect(revision).toBe(2)
    const canonical = readFileSync(dataFile, 'utf8')
    expect(JSON.parse(canonical).settings.theme).toBe('dark')
    const opened = openProfileStateDatabaseReadOnly(databasePath, 'profile-authority-test')
    try {
      expect(readProfileStateJsonAcceptance(opened.db)).toEqual({
        jsonHash: hashProfileStateJson(canonical),
        acceptedRevision: revision
      })
      expect(profileStateJsonMatchesAcceptance(opened.db, canonical)).toBe(true)
    } finally {
      opened.db.close()
    }
    authority.close()
    const reopened = createProfileStateStore({
      dataFile,
      databaseFile: databasePath,
      profileId: 'profile-authority-test',
      authorityMode: 'sqlite-established'
    })
    expect(reopened.backend).toBe('sqlite')
    expect(reopened.store.getSettings().theme).toBe('dark')
    reopened.store.freezeWrites()
    store.freezeWrites()
  })

  it('refuses to overwrite a conflicting export for the same SQLite revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-export-conflict-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'dark' } })))
    const store = new Store({ dataFile, profileStateAuthority: authority })
    const revision = store.writeLatestProfileStateJsonExport()
    if (revision === undefined) {
      throw new Error('Expected the SQLite authority to publish a revisioned export')
    }
    const exportPath = profileStateJsonExportPath(dataFile, revision)
    mkdirSync(dirname(exportPath), { recursive: true })
    writeFileSync(exportPath, '{"settings":{"theme":"tampered"}}', 'utf8')

    expect(() => store.writeLatestProfileStateJsonExport()).toThrow(
      'already exists with different content'
    )
    expect(readFileSync(exportPath, 'utf8')).toContain('tampered')
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith('orca-data.json.sqlite-export.pending.')
      )
    ).toBe(false)
    store.freezeWrites()
  })

  it('freezes Store writes before quarantining the SQLite database family', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-quarantine-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databasePath = join(directory, 'profile-state.db')
    const authority = createAuthority(databasePath, 'profile-authority-test')
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: 'light' } })))

    const store = new Store({ dataFile, profileStateAuthority: authority })
    store.updateSettings({ theme: 'dark' })
    store.flushOrThrow()
    const sourceBytes = readFileSync(databasePath)
    writeFileSync(`${databasePath}-wal`, 'wal-preservation-sentinel')

    const result = store.quarantineProfileStateDatabase(
      join(directory, 'quarantine'),
      'store-recovery-test'
    )

    expect(readFileSync(join(result.directory, 'profile-state.db'))).toEqual(sourceBytes)
    expect(readFileSync(join(result.directory, 'profile-state.db-wal'), 'utf8')).toBe(
      'wal-preservation-sentinel'
    )
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toMatchObject({
      profileId: 'profile-authority-test',
      reason: 'store-recovery-test'
    })
    expect(readFileSync(databasePath)).toEqual(sourceBytes)
  })

  it('keeps the Store export path JSON-compatible without creating SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-legacy-export-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const store = new Store({ dataFile })
    store.updateSettings({ theme: 'dark' })

    const exportPath = join(directory, 'rollback', 'orca-data.json.legacy.json')
    expect(store.writeProfileStateJsonExport(exportPath)).toBeUndefined()
    expect(JSON.parse(readFileSync(exportPath, 'utf8')).settings.theme).toBe('dark')
    expect(existsSync(join(directory, 'profile-state.db'))).toBe(false)
    store.freezeWrites()
  })
})
