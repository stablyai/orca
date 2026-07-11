/**
 * Task 7b (WSL native project support): a WSL repo is added with owning project
 * `repo:<uuid>` (no gitRemoteIdentity yet) and its
 * `localWindowsRuntimePreference` / `defaultShell` are stamped on THAT project.
 * When `repos:list` later runs `enrichMissingRepoGitRemoteIdentities`, the repo
 * gains a `gitRemoteIdentity`, so its owning project id shifts to
 * `git:<canonicalKey>`. The id-keyed project merge must migrate the
 * project-scoped settings to the new owning project instead of resetting the
 * project to native-git defaults.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/types'
import type { GitRemoteIdentity } from '../../shared/git-remote-identity'

// Shared mutable state so the electron mock can reference a per-test directory.
const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
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

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../repo-git-remote-identity', () => ({ detectGitRemoteIdentity: vi.fn() }))

import { Store, initDataPath } from '../persistence'
import { detectGitRemoteIdentity } from '../repo-git-remote-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from '../repo-git-remote-identity-enrichment'

// A non-GitHub remote so the enriched owning project id becomes `git:<key>`
// (the exact identity shift the bug depends on), not `github:<owner>/<repo>`.
const remoteIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/team/sample-app',
  remoteName: 'origin',
  remoteUrl: 'git@git.company.test:team/sample-app.git'
}
const enrichedProjectId = `git:${remoteIdentity.canonicalKey}`

const makeWslRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\j\\app',
  displayName: 'app',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  ...overrides
})

function createStore(): Store {
  initDataPath()
  return new Store()
}

async function runEnrichment(store: Store): Promise<void> {
  enrichMissingRepoGitRemoteIdentities(store as never)
  await flushRepoGitRemoteIdentityEnrichmentForTests()
}

describe('WSL project runtime pref survives gitRemoteIdentity enrichment', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-wsl-enrich-'))
    vi.mocked(detectGitRemoteIdentity).mockReset().mockResolvedValue(remoteIdentity)
  })

  afterEach(() => {
    resetRepoGitRemoteIdentityEnrichmentForTests()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('migrates both project-scoped settings when the owning project id shifts', async () => {
    const store = createStore()
    store.addRepo(makeWslRepo())

    // Stamped on the pre-enrichment `repo:<uuid>` project, exactly as the WSL
    // add flow does.
    store.updateProject('repo:r1', {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      defaultShell: 'powershell'
    })
    const before = store.getProjects().find((p) => p.id === 'repo:r1')
    expect(before?.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(before?.defaultShell).toBe('powershell')

    await runEnrichment(store)

    // The owning project id has shifted; the old row is gone and the new one
    // must still carry both settings.
    expect(store.getProjects().some((p) => p.id === 'repo:r1')).toBe(false)
    const after = store.getProjects().find((p) => p.id === enrichedProjectId)
    expect(after, 'enriched project should exist').toBeDefined()
    expect(after?.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(after?.defaultShell).toBe('powershell')
  })

  it('does not fabricate settings for a repo that never had any', async () => {
    const store = createStore()
    store.addRepo(makeWslRepo())

    await runEnrichment(store)

    const after = store.getProjects().find((p) => p.id === enrichedProjectId)
    expect(after, 'enriched project should exist').toBeDefined()
    expect(after?.localWindowsRuntimePreference).toBeUndefined()
    expect(after?.defaultShell).toBeUndefined()
  })
})
