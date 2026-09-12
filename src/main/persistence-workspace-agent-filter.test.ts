import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore, readDataFile, writeDataFile } from './persistence-test-harness'

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

function expectNoLeftoverAgentFilterKeys(ui: object): void {
  expect(ui).not.toHaveProperty('filterAgentId')
  expect(ui).not.toHaveProperty('filterHarnessId')
}

describe('Store workspace agent filter', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('loads leftover singular filterAgentId from an on-disk profile', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { filterAgentId: 'openclaude' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().filterAgentIds).toEqual(['openclaude'])
    expectNoLeftoverAgentFilterKeys(store.getUI())
    store.flush()
    expectNoLeftoverAgentFilterKeys((readDataFile() as { ui: Record<string, unknown> }).ui)
  })

  it('loads leftover harness-only filterHarnessId from an on-disk profile', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { filterHarnessId: 'cc' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().filterAgentIds).toEqual(['claude'])
    expectNoLeftoverAgentFilterKeys(store.getUI())
    store.flush()
    expectNoLeftoverAgentFilterKeys((readDataFile() as { ui: Record<string, unknown> }).ui)
  })

  it('updateUI hydrates leftover singular filterAgentId onto filterAgentIds', async () => {
    const store = await createStore()
    store.updateUI({ filterAgentId: 'openclaude' })

    expect(store.getUI().filterAgentIds).toEqual(['openclaude'])
    expectNoLeftoverAgentFilterKeys(store.getUI())

    store.flush()
    const persisted = readDataFile() as { ui: Record<string, unknown> }
    expect(persisted.ui.filterAgentIds).toEqual(['openclaude'])
    expectNoLeftoverAgentFilterKeys(persisted.ui)

    const reloaded = await createStore()
    expect(reloaded.getUI().filterAgentIds).toEqual(['openclaude'])
    expectNoLeftoverAgentFilterKeys(reloaded.getUI())
  })

  it('updateUI hydrates leftover harness-only filterHarnessId onto filterAgentIds', async () => {
    const store = await createStore()
    store.updateUI({ filterHarnessId: 'cc' })
    expect(store.getUI().filterAgentIds).toEqual(['claude'])
    expectNoLeftoverAgentFilterKeys(store.getUI())

    store.updateUI({ filterHarnessId: 'codex' })
    expect(store.getUI().filterAgentIds).toEqual(['codex'])
    expectNoLeftoverAgentFilterKeys(store.getUI())

    store.flush()
    const persisted = readDataFile() as { ui: Record<string, unknown> }
    expect(persisted.ui.filterAgentIds).toEqual(['codex'])
    expectNoLeftoverAgentFilterKeys(persisted.ui)
  })

  it('updateUI leftover singular payload replaces a stored filterAgentIds list', async () => {
    const store = await createStore()
    store.updateUI({ filterAgentIds: ['claude', 'codex'] })
    store.updateUI({ filterAgentId: 'openclaude' })

    expect(store.getUI().filterAgentIds).toEqual(['openclaude'])
    expectNoLeftoverAgentFilterKeys(store.getUI())
  })

  it('updateUI prefers incoming filterAgentIds when leftover keys are also present', async () => {
    const store = await createStore()
    store.updateUI({
      filterAgentIds: ['codex'],
      filterAgentId: 'openclaude',
      filterHarnessId: 'cc'
    })

    expect(store.getUI().filterAgentIds).toEqual(['codex'])
    expectNoLeftoverAgentFilterKeys(store.getUI())
  })

  it('updateUI keeps filterAgentIds when the payload has no agent-filter fields', async () => {
    const store = await createStore()
    store.updateUI({ filterAgentIds: ['claude'] })
    store.updateUI({ sidebarWidth: 400 })

    expect(store.getUI().filterAgentIds).toEqual(['claude'])
    expect(store.getUI().sidebarWidth).toBe(400)
    expectNoLeftoverAgentFilterKeys(store.getUI())
  })
})
