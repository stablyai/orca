import { closeTestStores, testState, createStore, makeRepo } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeAutomationController } from '../../runtime/runtime-automation-controller'

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
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const MODE_CHANGED =
  'This automation now runs in an existing worktree, so nothing was changed. Pass --workspace-mode new-per-run or omit --setup.'

async function newPerRunAutomation() {
  const store = await createStore()
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'Nightly',
    prompt: 'Run checks',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-13T00:00:00Z').getTime()
  })
  return { store, id: automation.id }
}

// Another client switching the automation to an existing worktree between the CLI's read and its write.
const switchToExisting = { workspaceMode: 'existing', workspaceId: 'r1::/repo/wt' } as const

describe('automation update workspace-mode precondition', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses the whole edit when the stored mode is no longer new-per-run', async () => {
    const { store, id } = await newPerRunAutomation()
    store.updateAutomation(id, switchToExisting)

    expect(() =>
      store.updateAutomation(
        id,
        { name: 'Renamed', setupDecision: 'run' },
        { expectedWorkspaceMode: 'new_per_run' }
      )
    ).toThrow(MODE_CHANGED)
    const stored = store.listAutomations().find((row) => row.id === id)
    expect(stored).toMatchObject({ name: 'Nightly', workspaceMode: 'existing' })
    expect(stored?.setupDecision).toBeUndefined()
  })

  it('refuses when the mode changes while the controller resolves a repo move', async () => {
    const { store, id } = await newPerRunAutomation()
    let resolveRepo = (): void => {}
    const repoLookup = new Promise<void>((resolve) => {
      resolveRepo = resolve
    })
    const controller = new RuntimeAutomationController(store, {
      showRepo: async () => {
        await repoLookup
        return makeRepo()
      },
      showManagedWorktree: async () => {
        throw new Error('Unexpected worktree lookup.')
      }
    })

    // The controller derives new-per-run from its earlier read, so only the store's check can catch this.
    const update = controller.update(
      id,
      { repo: 'id:r1', name: 'Renamed', setupDecision: 'run' },
      { expectedWorkspaceMode: 'new_per_run' }
    )
    store.updateAutomation(id, switchToExisting)
    resolveRepo()

    await expect(update).rejects.toThrow(MODE_CHANGED)
    expect(store.listAutomations().find((row) => row.id === id)).toMatchObject({
      name: 'Nightly',
      workspaceMode: 'existing'
    })
  })

  it('saves a setup edit through the controller when the mode still holds', async () => {
    const { store, id } = await newPerRunAutomation()
    const controller = new RuntimeAutomationController(store, {
      showRepo: async () => makeRepo(),
      showManagedWorktree: async () => {
        throw new Error('Unexpected worktree lookup.')
      }
    })

    await controller.update(
      id,
      { name: 'Renamed', setupDecision: 'run' },
      { expectedWorkspaceMode: 'new_per_run' }
    )

    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations().find((row) => row.id === id)).toMatchObject({
      name: 'Renamed',
      workspaceMode: 'new_per_run',
      setupDecision: 'run'
    })
  })

  it('keeps the existing normalization for updates without the precondition', async () => {
    const { store, id } = await newPerRunAutomation()
    store.updateAutomation(id, switchToExisting)

    const updated = store.updateAutomation(id, { name: 'Renamed', setupDecision: 'run' })

    expect(updated).toMatchObject({ name: 'Renamed', workspaceMode: 'existing' })
    expect(updated.setupDecision).toBeUndefined()
  })
})
