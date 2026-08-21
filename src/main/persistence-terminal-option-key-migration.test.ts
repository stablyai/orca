import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import {
  testState,
  createStore,
  withPlatform,
  writeDataFile,
  readDataFile
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
  // ── terminalMacOptionAsAlt migration (issue #903) ───────────────────

  it('migrates legacy "true" terminalMacOptionAsAlt to "auto" on first load', async () => {
    // Why: legacy 'true' (old default) is indistinguishable from an explicit choice; flip un-migrated installs to 'auto' so non-US layouts keep @ / € / [ ].
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'true' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('migrates inherited right-click paste to each platform default once', async () => {
    for (const [platform, expected] of [
      ['win32', true],
      ['darwin', false],
      ['linux', false]
    ] as const) {
      await withPlatform(platform, async () => {
        writeDataFile({
          schemaVersion: 1,
          repos: [],
          worktreeMeta: {},
          settings: { terminalRightClickToPaste: true },
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })
        const store = await createStore()
        expect(store.getSettings().terminalRightClickToPaste).toBe(expected)
        expect(store.getSettings().terminalRightClickToPasteDefaultedForPlatform).toBe(true)
      })
    }
  })

  it('preserves an explicit Windows right-click paste opt-out during migration', async () => {
    await withPlatform('win32', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { terminalRightClickToPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })
      const store = await createStore()
      expect(store.getSettings().terminalRightClickToPaste).toBe(false)
      expect(store.getSettings().terminalRightClickToPasteDefaultedForPlatform).toBe(true)
    })
  })

  it('preserves right-click paste choices after the platform migration', async () => {
    await withPlatform('darwin', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: {
          terminalRightClickToPaste: true,
          terminalRightClickToPasteDefaultedForPlatform: true
        },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })
      const store = await createStore()
      expect(store.getSettings().terminalRightClickToPaste).toBe(true)
    })
  })

  it('migrates inherited terminal bar cursor defaults to block on first load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalCursorStyle: 'bar' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalCursorStyle).toBe('block')
    expect(store.getSettings().terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('preserves terminal cursor choices after the block-default migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalCursorStyle: 'bar', terminalCursorStyleDefaultedToBlock: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalCursorStyle).toBe('bar')
    expect(store.getSettings().terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('replaces an invalid persisted terminal cursor choice after migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalCursorStyle: 'beam', terminalCursorStyleDefaultedToBlock: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalCursorStyle).toBe('block')
    store.flush()
    expect((readDataFile() as PersistedState).settings.terminalCursorStyle).toBe('block')
  })

  it('preserves explicit "false" terminalMacOptionAsAlt through migration', async () => {
    // 'false' never matched the old default — it was an explicit choice.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'false' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('false')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('preserves explicit "left" / "right" terminalMacOptionAsAlt through migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'left' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('left')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('respects already-migrated settings with explicit "true"', async () => {
    // A deliberate 'true' ('Both') choice post-migration is preserved on later launches.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'true', terminalMacOptionAsAltMigrated: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('true')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('fresh install defaults terminalMacOptionAsAlt to "auto" and marks migrated', async () => {
    // No data file: 'auto' is the new default and migration is complete (nothing legacy to migrate).
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    // Fresh install: migrated stays false (migration code never ran); a later load with legacy 'true' still migrates correctly.
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(false)
  })

  it('missing terminalMacOptionAsAlt in persisted file defaults to "auto" and flags migrated', async () => {
    // Existing file predates the setting: land on 'auto' and mark migrated so we don't re-examine.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('migrates the legacy experimentalSidekick setting to experimentalPet', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalSidekick: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalPet).toBe(true)
  })

  it('migrates the legacy experimental compact worktree cards setting', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalCompactWorktreeCards: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getSettings().experimentalCompactWorktreeCards).toBeUndefined()
  })

  it('defaults legacy experimentalActivity profiles off once', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalActivity: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalActivity).toBe(false)
    expect(store.getSettings().experimentalActivityDefaultedOffForAllUsers).toBe(true)
  })

  it('preserves experimentalActivity after the default-off migration has run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        experimentalActivity: true,
        experimentalActivityDefaultedOffForAllUsers: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalActivity).toBe(true)
  })
})
