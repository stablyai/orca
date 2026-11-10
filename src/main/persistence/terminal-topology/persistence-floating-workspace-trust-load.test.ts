import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  symlinkDirectorySync
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFloatingWorkspaceFileRoots } from '../../ipc/floating-workspace-directory'
import { rmSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('floating workspace trust on load', () => {
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
  it('seeds trust from a legacy explicit cwd and stores the cwd in that canonical spelling', async () => {
    const legacyTarget = join(testState.dir, 'legacy-floating-target')
    const legacyFloatingCwd = join(testState.dir, 'legacy-floating-cwd')
    mkdirSync(legacyTarget)
    symlinkDirectorySync(legacyTarget, legacyFloatingCwd)
    const canonicalLegacyFloatingCwd = realpathSync(legacyTarget)
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

    // File authorization matches the trusted cwd textually, so both must share one spelling.
    expect(store.getSettings().floatingTerminalCwd).toBe(canonicalLegacyFloatingCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([canonicalLegacyFloatingCwd])
    store.flush()
    expect(readDataFile()).toMatchObject({
      settings: { floatingTerminalTrustedCwds: [canonicalLegacyFloatingCwd] }
    })
  })

  it('still loads a profile whose floating cwd is not a string', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: 42,
        floatingTerminalCwdMigratedToAppWorkspace: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe('~')
    // File authorization reads the cwd on every check, so it must keep working for this profile.
    expect(getFloatingWorkspaceFileRoots(store).exactRoots).toEqual([])
  })

  it('never re-points a trusted folder through a link on load', async () => {
    const trustedTarget = join(testState.dir, 'trusted-target')
    const trustedLink = join(testState.dir, 'trusted-link')
    mkdirSync(trustedTarget)
    symlinkDirectorySync(trustedTarget, trustedLink)
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

    // A trusted folder swapped for a link keeps its approved identity and fails closed (#36950).
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([trustedLink])
    store.flush()
    expect(readDataFile()).toMatchObject({
      settings: { floatingTerminalTrustedCwds: [trustedLink] }
    })
  })
})
