import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  it('migrates the legacy floating terminal disabled default to enabled', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { floatingTerminalEnabled: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().floatingTerminalEnabled).toBe(true)
    expect(store.getSettings().floatingTerminalDefaultedForAllUsers).toBe(true)
  })

  it('preserves a post-migration floating terminal opt-out', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalEnabled: false,
        floatingTerminalDefaultedForAllUsers: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().floatingTerminalEnabled).toBe(false)
    expect(store.getSettings().floatingTerminalDefaultedForAllUsers).toBe(true)
  })

  it('migrates the legacy OSC 52 clipboard disabled default to enabled', async () => {
    // Why this migration exists: the old off default was persisted for every
    // profile, so without the one-shot flip #10567 would only fix new installs.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalAllowOsc52Clipboard: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().terminalAllowOsc52Clipboard).toBe(true)
    expect(store.getSettings().terminalAllowOsc52ClipboardDefaultedOnForAllUsers).toBe(true)
  })

  it('persists the OSC 52 clipboard migration stamp back to disk', async () => {
    // Why round-trip a store first: on a bare legacy profile ~30 other migrations also
    // set loadNeedsSave, so the save happens regardless and this migration's own dirty
    // flag goes untested. Re-loading a profile the new build already wrote leaves OSC 52
    // as the only unmigrated key — which is exactly the upgrade case that matters.
    // Why no flush(): flush() writes unconditionally, so only the debounced load-path
    // save proves this migration marked the state dirty by itself.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const migrated = await createStore()
    migrated.flush()

    const settled = readDataFile() as { settings: Record<string, unknown> }
    settled.settings.terminalAllowOsc52Clipboard = false
    delete settled.settings.terminalAllowOsc52ClipboardDefaultedOnForAllUsers
    writeDataFile(settled)

    vi.useFakeTimers()
    try {
      const store = await createStore()
      // Why over-advance: the debounce is exactly 1000ms, so an exact-fit advance turns a
      // future debounce raise into a confusing no-write instead of a loud failure.
      vi.advanceTimersByTime(5000)
      await store.waitForPendingWrite()
    } finally {
      vi.useRealTimers()
    }

    const persisted = readDataFile() as {
      settings?: {
        terminalAllowOsc52Clipboard?: boolean
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers?: boolean
      }
    }

    expect(persisted.settings?.terminalAllowOsc52Clipboard).toBe(true)
    expect(persisted.settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers).toBe(true)
  })

  it('preserves a post-migration OSC 52 clipboard opt-out', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        terminalAllowOsc52Clipboard: false,
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().terminalAllowOsc52Clipboard).toBe(false)
    expect(store.getSettings().terminalAllowOsc52ClipboardDefaultedOnForAllUsers).toBe(true)
  })

  it('arms the one-shot notice when the OSC 52 flip overrides a persisted off', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalAllowOsc52Clipboard: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().osc52ClipboardDefaultOnNoticePending).toBe(true)
  })

  it('leaves the OSC 52 notice disarmed for a profile with no persisted value', async () => {
    // Why: the notice explains an overridden choice; a fresh profile made no choice.
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
    expect(store.getUI().osc52ClipboardDefaultOnNoticePending).toBe(false)
  })

  it('keeps the OSC 52 notice armed on disk until the renderer clears it', async () => {
    // Why the disk assertion: the flip happens during load, before any window exists, and
    // once the settings stamp lands the arming predicate is false forever — so the on-disk
    // ui flag is the only thing that survives a crash before the toast renders.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalAllowOsc52Clipboard: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const armed = await createStore()
    armed.flush()
    const armedOnDisk = readDataFile() as {
      ui?: { osc52ClipboardDefaultOnNoticePending?: boolean }
    }
    expect(armedOnDisk.ui?.osc52ClipboardDefaultOnNoticePending).toBe(true)

    const reloaded = await createStore()
    expect(reloaded.getUI().osc52ClipboardDefaultOnNoticePending).toBe(true)

    reloaded.updateUI({ osc52ClipboardDefaultOnNoticePending: false })
    reloaded.flush()
    const cleared = await createStore()
    // Why re-check after the stamp: a cleared notice must not be resurrected by a later load.
    expect(cleared.getUI().osc52ClipboardDefaultOnNoticePending).toBe(false)
  })

  it('migrates the legacy Linux primary-selection default to enabled', async () => {
    await withPlatform('linux', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { primarySelectionMiddleClickPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForLinux).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('preserves a post-migration Linux primary-selection opt-out', async () => {
    await withPlatform('linux', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: {
          primarySelectionMiddleClickPaste: false,
          primarySelectionMiddleClickPasteDefaultedForLinux: true
        },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForLinux).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('migrates the legacy macOS primary-selection default to enabled', async () => {
    await withPlatform('darwin', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { primarySelectionMiddleClickPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForLinux).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('preserves a post-migration macOS primary-selection opt-out', async () => {
    await withPlatform('darwin', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: {
          primarySelectionMiddleClickPaste: false,
          primarySelectionMiddleClickPasteDefaultedForTerminalDefaults: true
        },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('keeps the primary-selection default disabled on Windows profiles', async () => {
    await withPlatform('win32', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { primarySelectionMiddleClickPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        false
      )
    })
  })
})
