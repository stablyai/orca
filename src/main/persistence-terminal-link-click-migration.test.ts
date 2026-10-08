import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

describe('terminal link click behavior migration', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  function writeSettings(settings: Record<string, unknown>): void {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings,
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
  }

  it('carries a legacy link-actions opt-out into the plain-click setting once', async () => {
    writeSettings({ terminalLinkActionPopoverEnabled: false })

    const store = await createStore()
    expect(store.getSettings().terminalLinkClickBehavior).toBe('none')
    store.flush()
    expect(readDataFile()).toMatchObject({
      settings: { terminalLinkClickBehavior: 'none', terminalLinkClickBehaviorMigrated: true }
    })
  })

  it('treats a defaulted actions value saved beside the legacy opt-out as the opt-out', async () => {
    writeSettings({ terminalLinkActionPopoverEnabled: false, terminalLinkClickBehavior: 'actions' })

    const store = await createStore()
    expect(store.getSettings().terminalLinkClickBehavior).toBe('none')
  })

  it('keeps an explicit open choice over the legacy opt-out', async () => {
    writeSettings({ terminalLinkActionPopoverEnabled: false, terminalLinkClickBehavior: 'open' })

    const store = await createStore()
    expect(store.getSettings().terminalLinkClickBehavior).toBe('open')
  })

  it('lets actions stick after migration even with the legacy opt-out stored', async () => {
    writeSettings({ terminalLinkActionPopoverEnabled: false })
    const first = await createStore()
    first.updateSettings({ terminalLinkClickBehavior: 'actions' })
    first.flush()
    await closeTestStores()

    const reloaded = await createStore()
    expect(reloaded.getSettings().terminalLinkClickBehavior).toBe('actions')
  })
})
