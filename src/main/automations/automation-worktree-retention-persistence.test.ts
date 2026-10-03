import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore, makeRepo, testState } from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

describe('automation worktree retention persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-retention-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stores keep-last for new-per-run and drops it when the automation reuses a workspace', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      name: 'Patrol',
      prompt: 'Inspect',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      worktreeRetention: { mode: 'keep_last', count: 2 },
      timezone: 'UTC',
      rrule: 'FREQ=HOURLY;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00Z').getTime()
    })
    expect(created.worktreeRetention).toEqual({ mode: 'keep_last', count: 2 })

    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0]?.worktreeRetention).toEqual({
      mode: 'keep_last',
      count: 2
    })

    const cleared = reloaded.updateAutomation(created.id, { worktreeRetention: null })
    expect(cleared.worktreeRetention).toBeUndefined()
    const switched = reloaded.updateAutomation(created.id, {
      workspaceMode: 'existing',
      workspaceId: 'wt-user',
      worktreeRetention: { mode: 'keep' }
    })
    expect(switched.worktreeRetention).toBeUndefined()
  })
})
