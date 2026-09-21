import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  symlinkDirectorySync
} from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('seeds trusted floating workspace directories from legacy explicit cwd values', async () => {
    const legacyFloatingCwd = join(testState.dir, 'legacy-floating-cwd')
    mkdirSync(legacyFloatingCwd)
    const canonicalLegacyFloatingCwd = realpathSync(legacyFloatingCwd)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: legacyFloatingCwd
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe(legacyFloatingCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([canonicalLegacyFloatingCwd])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([canonicalLegacyFloatingCwd])
  })

  it('persists the floating cwd migration marker when a legacy explicit cwd is unavailable', async () => {
    const unavailableLegacyFloatingCwd = join(testState.dir, 'missing-floating-cwd')
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: unavailableLegacyFloatingCwd
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe(unavailableLegacyFloatingCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalCwdMigratedToAppWorkspace?: boolean } })
        .settings?.floatingTerminalCwdMigratedToAppWorkspace
    ).toBe(true)
  })

  it('does not seed trusted floating workspace directories after the cwd migration has run', async () => {
    const postMigrationCwd = join(testState.dir, 'post-migration-cwd')
    mkdirSync(postMigrationCwd)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: postMigrationCwd,
        floatingTerminalCwdMigratedToAppWorkspace: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe(postMigrationCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
  })

  it('restores migrated blank floating terminal cwd settings to home shorthand', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: '',
        floatingTerminalCwdMigratedToAppWorkspace: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe('~')
  })

  it('preserves legacy home shorthand as the floating terminal cwd', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: '~'
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe('~')
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
  })

  it('canonicalizes persisted floating workspace trust paths on load', async () => {
    const trustedTarget = join(testState.dir, 'trusted-target')
    const trustedLink = join(testState.dir, 'trusted-link')
    mkdirSync(trustedTarget)
    symlinkDirectorySync(trustedTarget, trustedLink)
    const canonicalTrustedTarget = realpathSync(trustedTarget)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalTrustedCwds: [trustedLink]
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([canonicalTrustedTarget])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([canonicalTrustedTarget])
  })

  it('preserves temporarily unavailable floating workspace trust paths on load', async () => {
    const unavailableTrustedPath = join(testState.dir, 'offline-drive', 'notes')
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalTrustedCwds: [unavailableTrustedPath]
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([unavailableTrustedPath])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([unavailableTrustedPath])
  })

  it('drops blank floating workspace trust paths on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalTrustedCwds: ['', '   ']
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([])
  })

  it('preserves custom notification sound paths from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg'
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications).toMatchObject({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      suppressWhenFocused: true,
      customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg',
      customSoundVolume: 100
    })
  })

  it('clamps notification custom sound volume from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundVolume: 250
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications.customSoundVolume).toBe(100)
  })

  it('defaults invalid notification custom sound volume from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundVolume: Number.NaN
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications.customSoundVolume).toBe(100)
  })

  it('preserves editorAutoSaveDelayMs when set in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { editorAutoSaveDelayMs: 2500 },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().editorAutoSaveDelayMs).toBe(2500)
  })

  it('preserves editorAutoSave when set to true in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { editorAutoSave: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().editorAutoSave).toBe(true)
  })

  it('keeps legacy rightSidebarOpenByDefault readable from persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { rightSidebarOpenByDefault: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
  })

  it('preserves terminalUseSeparateLightTheme when persisted as false', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalUseSeparateLightTheme: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().terminalUseSeparateLightTheme).toBe(false)
  })

  it('round-trips selected terminal theme names across reload', async () => {
    const store = await createStore()

    store.updateSettings({
      terminalThemeDark: 'One Light',
      terminalThemeLight: 'GitHub Light'
    })
    store.flush()

    const persisted = readDataFile() as PersistedState
    expect(persisted.settings.terminalThemeDark).toBe('One Light')
    expect(persisted.settings.terminalThemeLight).toBe('GitHub Light')

    const reopened = await createStore()
    expect(reopened.getSettings().terminalThemeDark).toBe('One Light')
    expect(reopened.getSettings().terminalThemeLight).toBe('GitHub Light')
  })
})
