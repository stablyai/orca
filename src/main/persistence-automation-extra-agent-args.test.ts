import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  makeRepo
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./ssh/ssh-config-parser', () => ({
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

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const BASE = {
  name: 'Docs pass',
  prompt: 'Tidy docs',
  agentId: 'claude' as const,
  projectId: 'r1',
  workspaceMode: 'existing' as const,
  workspaceId: 'r1::/tmp/r1',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: new Date('2026-05-13T00:00:00Z').getTime()
}

describe('automation extra agent args persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps host launch facts immutable across edits, completion, and reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })
    const run = store.createAutomationRun(automation, Date.now())
    expect(run.launchSnapshot).toBeUndefined()
    const snapshot = { agentId: 'claude' as const, effectiveAgentArgs: '--verbose --model opus' }
    store.updateAutomationRun({ runId: run.id, status: 'dispatched', launchSnapshot: snapshot })
    snapshot.effectiveAgentArgs = 'mutated by caller'
    const readSnapshot = store.listAutomationRuns()[0].launchSnapshot
    if (readSnapshot) {
      readSnapshot.effectiveAgentArgs = 'mutated by reader'
    }
    store.updateAutomation(automation.id, { agentId: 'codex', extraAgentArgs: '-m other' })
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      launchSnapshot: { agentId: 'codex', effectiveAgentArgs: 'replacement' }
    })
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomationRuns()[0].launchSnapshot).toEqual({
      agentId: 'claude',
      effectiveAgentArgs: '--verbose --model opus'
    })
  })

  it('preserves unknown old records and known empty host arguments', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation(BASE)
    const old = store.createAutomationRun(automation, 1)
    store.updateAutomationRun({ runId: old.id, status: 'completed' })
    const fresh = store.createAutomationRun(automation, 2)
    store.updateAutomationRun({
      runId: fresh.id,
      status: 'dispatched',
      launchSnapshot: { agentId: 'claude', effectiveAgentArgs: '' }
    })
    store.updateAutomationRun({ runId: fresh.id, status: 'completed' })
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(
      reloaded.listAutomationRuns().find((run) => run.id === old.id)?.launchSnapshot
    ).toBeUndefined()
    expect(
      reloaded.listAutomationRuns().find((run) => run.id === fresh.id)?.launchSnapshot
        ?.effectiveAgentArgs
    ).toBe('')
  })

  it('stores the exact text and survives a reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const text = '  --model opus --add-dir "docs/my specs"  '
    const automation = store.createAutomation({ ...BASE, extraAgentArgs: text })

    expect(automation.extraAgentArgs).toBe(text)
    store.flush()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store just flushed this automation to the data file.
    const persisted = readDataFile() as { automations: { extraAgentArgs?: string }[] }
    expect(persisted.automations[0].extraAgentArgs).toBe(text)
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].extraAgentArgs).toBe(text)
  })

  it('stores no field for empty or whitespace input', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    for (const extraAgentArgs of ['', '   ', undefined]) {
      const automation = store.createAutomation({ ...BASE, extraAgentArgs })
      expect(Object.hasOwn(automation, 'extraAgentArgs')).toBe(false)
    }
  })

  it('preserves on omission, replaces, and clears with empty or whitespace text', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })

    // An older client's unrelated patch carries no extras key.
    expect(store.updateAutomation(id, { name: 'Renamed' }).extraAgentArgs).toBe('--model opus')
    expect(store.updateAutomation(id, { extraAgentArgs: '--effort high' }).extraAgentArgs).toBe(
      '--effort high'
    )
    expect(
      Object.hasOwn(store.updateAutomation(id, { extraAgentArgs: '  ' }), 'extraAgentArgs')
    ).toBe(false)
    store.updateAutomation(id, { extraAgentArgs: '--model opus' })
    expect(
      Object.hasOwn(store.updateAutomation(id, { extraAgentArgs: '' }), 'extraAgentArgs')
    ).toBe(false)
  })

  it('rejects invalid extras without changing the record', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    expect(() =>
      store.createAutomation({ ...BASE, extraAgentArgs: '--dangerously-skip-permissions' })
    ).toThrow('"--dangerously-skip-permissions"')
    const { id } = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })
    expect(() => store.updateAutomation(id, { extraAgentArgs: '--resume x' })).toThrow('"--resume"')
    expect(() =>
      // @ts-expect-error -- the wire can carry null; the store must refuse it rather than clear.
      store.updateAutomation(id, { extraAgentArgs: null })
    ).toThrow('must be text')
    expect(store.listAutomations()[0].extraAgentArgs).toBe('--model opus')
  })

  it('validates the merged record so enabling Reuse with stored extras fails', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })

    expect(() => store.updateAutomation(id, { reuseSession: true })).toThrow(
      'Extra arguments require a fresh session for every run.'
    )
    expect(() =>
      store.createAutomation({ ...BASE, reuseSession: true, extraAgentArgs: '--model opus' })
    ).toThrow('fresh session')
    // Switching to an agent without modeled options re-validates the stored extras.
    expect(() => store.updateAutomation(id, { agentId: 'gemini' })).toThrow("aren't supported")
    expect(
      store.updateAutomation(id, { extraAgentArgs: '', reuseSession: true }).reuseSession
    ).toBe(true)
  })
})
