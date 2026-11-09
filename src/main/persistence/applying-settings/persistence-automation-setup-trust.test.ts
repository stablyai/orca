import { closeTestStores, testState, createStore, makeRepo } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

async function automationApprovedToRunSetup() {
  const store = await createStore()
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'Nightly',
    prompt: 'Run checks',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    setupDecision: 'run',
    setupTrustHash: 'approved-hash',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-13T00:00:00Z').getTime()
  })
  return { store, id: automation.id }
}

describe('automation setup trust hash', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the approved hash across reloads and unrelated edits', async () => {
    const { store, id } = await automationApprovedToRunSetup()
    store.updateAutomation(id, { name: 'Renamed' })

    const reloaded = await createStore()
    expect(reloaded.listAutomations().find((row) => row.id === id)?.setupTrustHash).toBe(
      'approved-hash'
    )
  })

  it('drops the approval when the setup decision is rewritten without one', async () => {
    const { store, id } = await automationApprovedToRunSetup()

    // The CLI's --setup run carries no approval, so runs fall back to today's behaviour.
    expect(store.updateAutomation(id, { setupDecision: 'run' }).setupTrustHash).toBeUndefined()
    expect(
      store.updateAutomation(id, { setupDecision: 'run', setupTrustHash: 'next-hash' })
        .setupTrustHash
    ).toBe('next-hash')
    expect(store.updateAutomation(id, { setupDecision: 'skip' }).setupTrustHash).toBeUndefined()
  })
})
