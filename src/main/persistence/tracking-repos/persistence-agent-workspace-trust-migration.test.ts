import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../../shared/repo-types'

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

function writeProfile(repos: Repo[], settings: Record<string, unknown> = {}): void {
  writeDataFile({
    schemaVersion: 1,
    repos,
    worktreeMeta: {},
    settings,
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })
}

describe('keeping agent pre-trust for repos saved before per-repo decisions', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('pins existing repos to pre-trust and keeps explicit answers', async () => {
    writeProfile([
      makeRepo({ id: 'existing', path: '/repos/existing' }),
      makeRepo({ id: 'asks', path: '/repos/asks', agentWorkspaceTrust: 'agent-asks' })
    ])

    const store = await createStore()

    expect(store.getRepo('existing')?.agentWorkspaceTrust).toBe('pre-trust')
    expect(store.getRepo('asks')?.agentWorkspaceTrust).toBe('agent-asks')
    expect(store.getSettings().agentWorkspaceTrustExistingReposMigrated).toBe(true)
  })

  it('leaves repos undecided when the user had turned folder trust off', async () => {
    writeProfile([makeRepo({ id: 'existing', path: '/repos/existing' })], {
      agentWorkspaceTrustEnabled: false
    })

    const store = await createStore()

    expect(store.getRepo('existing')).not.toHaveProperty('agentWorkspaceTrust')
    expect(store.getSettings().agentWorkspaceTrustEnabled).toBe(false)
  })

  it('runs once, so repos added after the upgrade stay undecided', async () => {
    writeProfile([makeRepo({ id: 'added-later', path: '/repos/added-later' })], {
      agentWorkspaceTrustExistingReposMigrated: true
    })

    const store = await createStore()

    expect(store.getRepo('added-later')).not.toHaveProperty('agentWorkspaceTrust')
  })
})
