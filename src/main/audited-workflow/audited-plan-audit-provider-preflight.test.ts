// PRE-ADMISSION PROVIDER REFUSAL.
//
// A provider/credential problem never reached Codex, so it must not create a
// review-run row, write task state, append a transition, or block the task —
// the same guarantee acceptance_criteria_unavailable already has. Routing these
// through launch_plan_invalid instead would mark a task blocked by a process
// failure that never happened, and leave a spurious `failed` run in the audit
// history.
//
// Every case asserts all four: closed reason code, no review row, no runner
// call, and a byte-identical task row + transition count.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as ProviderKeyStore from './audited-codex-provider-key-store'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string
let orcaHome: string

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => userData) },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => orcaHome }
})

vi.mock('./audited-worktree-service', () => ({
  verifyWorktreeForTask: vi.fn(async () => ({ ok: true })),
  ensureWorktreeForTask: vi.fn(),
  setAuditedWorktreeStore: vi.fn(),
  rebuildAuditedWorktreeRegistry: vi.fn(),
  reconcileAuditedWorktreesOnStartup: vi.fn(),
  recoverWorktreeForTask: vi.fn()
}))

const codexRunner = vi.fn()

// Wraps the REAL key store so behaviour is unchanged, but every call to the
// value-reading function is recorded. Admission must never reach it.
const readKeySpy = vi.fn()
// Defaults to the real probe; a test may override it to simulate an unreadable
// ~/.orca without touching the filesystem's permission bits.
const hasKeySpy = vi.fn()
vi.mock('./audited-codex-provider-key-store', async () => {
  const actual = await vi.importActual<typeof ProviderKeyStore>(
    './audited-codex-provider-key-store'
  )
  return {
    ...actual,
    readAuditedCodexProviderKey: (...args: []) => {
      readKeySpy(...args)
      return actual.readAuditedCodexProviderKey(...args)
    },
    hasAuditedCodexProviderKey: (...args: []) => hasKeySpy(...args)
  }
})

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { derivePlanArtifact } from './audited-plan-artifact-derivation'
import { getCurrentPlanArtifact } from './audited-plan-artifact-repository'
import { setAuditedCodexRunnerForTests } from './audited-plan-audit-launcher'
import { startPlanAudit } from './audited-plan-review-orchestration'
import {
  clearAuditedCodexProviderKey,
  resetAuditedCodexProviderKeyCacheForTests,
  saveAuditedCodexProviderKey
} from './audited-codex-provider-key-store'
import { isRetryablePlanReviewReasonCode } from '../../shared/audited-plan-artifact-types'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
const WT_PATH = 'C:\\orca\\worktrees\\audited-1'
const CRITERIA = [{ id: 'ac1', text: 'It works.', covered: false }]
const PROVIDER_KEY_FILE = 'audited-workflow-codex-provider-token.enc'

function makeTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: '/tmp/repo',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'T',
    spec: { title: 'T', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

function seedReviewableTask(): string {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = 'audited/1',
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = 1 WHERE id = ?`
    )
    .run(WT_PATH, taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: 'A plan.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  repository
    .getDatabase()
    .prepare(
      `INSERT INTO audited_triage_runs
         (id, task_id, status, decision, acceptance_criteria_json, next_step_prompt,
          started_at_ms, ended_at_ms)
       VALUES (?, ?, 'succeeded', 'plan', ?, 'go', 1, 2)`
    )
    .run(`triage_${taskId}`, taskId, JSON.stringify(CRITERIA))
  getCurrentPlanArtifact(repository.getDatabase(), taskId)
  return taskId
}

function reviewRunCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_plan_review_runs WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

function snapshotTask(taskId: string): unknown {
  return repository.getDatabase().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId)
}

function transitionCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_transitions WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

/** Every pre-admission refusal must leave all of this untouched. */
function expectNothingWritten(taskId: string, before: unknown, transitions: number): void {
  expect(codexRunner).not.toHaveBeenCalled()
  expect(reviewRunCount(taskId)).toBe(0)
  expect(snapshotTask(taskId)).toEqual(before)
  expect(transitionCount(taskId)).toBe(transitions)
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-preflight-'))
  orcaHome = mkdtempSync(join(tmpdir(), 'orca-preflight-home-'))
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  codexRunner.mockReset()
  codexRunner.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: '', stderr: '' })
  setAuditedCodexRunnerForTests(codexRunner)
  readKeySpy.mockClear()
  hasKeySpy.mockReset()
  // Real behaviour by default; only the storage-failure cases override it.
  hasKeySpy.mockImplementation(() => existsSync(join(orcaHome, '.orca', PROVIDER_KEY_FILE)))
  resetAuditedCodexProviderKeyCacheForTests()
})

afterEach(() => {
  setAuditedCodexRunnerForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  resetAuditedCodexProviderKeyCacheForTests()
  repository.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(orcaHome, { recursive: true, force: true })
})

describe('no provider configured', () => {
  it('leaves existing default-provider behaviour unchanged', async () => {
    const taskId = seedReviewableTask()

    const result = await startPlanAudit(taskId)

    // The default path still runs: Phase 5 behaviour is not regressed by adding
    // provider support.
    expect(result).toEqual({ ok: true })
    expect(codexRunner).toHaveBeenCalledTimes(1)
    expect(reviewRunCount(taskId)).toBe(1)
  })
})

describe('provider configured while credential delivery is disabled', () => {
  it('refuses with credential_delivery_unavailable and writes NOTHING', async () => {
    const taskId = seedReviewableTask()
    const before = snapshotTask(taskId)
    const transitions = transitionCount(taskId)
    saveAuditedCodexProviderKey('provider-key')

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'credential_delivery_unavailable'
    })
    expectNothingWritten(taskId, before, transitions)
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })

  it('does NOT report provider_not_configured when a key exists', async () => {
    // The distinction is the point: the user configured something real, so
    // telling them to configure a key would be a lie about their own state.
    const taskId = seedReviewableTask()
    saveAuditedCodexProviderKey('provider-key')

    const result = await startPlanAudit(taskId)

    expect(result).toMatchObject({ reasonCode: 'credential_delivery_unavailable' })
    expect(result).not.toMatchObject({ reasonCode: 'provider_not_configured' })
  })
})

describe('a corrupt record is NOT distinguished — that would require a read', () => {
  it('resolves identically to a good record, writing NOTHING', async () => {
    const taskId = seedReviewableTask()
    const before = snapshotTask(taskId)
    const transitions = transitionCount(taskId)

    saveAuditedCodexProviderKey('provider-key')
    resetAuditedCodexProviderKeyCacheForTests()
    // A record that exists but could never decrypt.
    writeFileSync(
      join(orcaHome, '.orca', 'audited-workflow-codex-provider-token.enc'),
      '   ',
      'utf8'
    )

    const result = await startPlanAudit(taskId)

    // Telling corrupt from good means DECRYPTING, which admission must not do.
    // A better error message is not worth a real secret read.
    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'credential_delivery_unavailable'
    })
    expectNothingWritten(taskId, before, transitions)
  })
})

describe('the key-existence probe itself fails', () => {
  // Sentinels that must never escape: a filesystem path and a secret-shaped
  // value, both realistic for an errno-style storage error.
  const SENTINEL_PATH = 'C:\\Users\\victim\\.orca\\audited-workflow-codex-provider-token.enc'
  const SENTINEL_SECRET = 'sk-SENTINEL-provider-secret-0123456789'

  function throwStorageError(): never {
    const error = new Error(`EACCES: permission denied, open '${SENTINEL_PATH}' ${SENTINEL_SECRET}`)
    Object.assign(error, { code: 'EACCES', path: SENTINEL_PATH })
    throw error
  }

  it('returns a closed result instead of rejecting, and writes NOTHING', async () => {
    const taskId = seedReviewableTask()
    const before = snapshotTask(taskId)
    const transitions = transitionCount(taskId)
    hasKeySpy.mockImplementation(throwStorageError)

    // The defect this guards: an unguarded probe made startPlanAudit REJECT, so
    // the IPC catch-all reported `spawn_failed` — untruthful, nothing spawned —
    // while logging the raw error and its path.
    const result = await startPlanAudit(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'provider_storage_unavailable'
    })
    expectNothingWritten(taskId, before, transitions)
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })

  it('leaks neither the path nor the secret into the result', async () => {
    const taskId = seedReviewableTask()
    hasKeySpy.mockImplementation(throwStorageError)

    const serialized = JSON.stringify(await startPlanAudit(taskId))

    expect(serialized).not.toContain(SENTINEL_PATH)
    expect(serialized).not.toContain(SENTINEL_SECRET)
    expect(serialized).not.toContain('EACCES')
  })

  it('leaks neither into console diagnostics', async () => {
    const taskId = seedReviewableTask()
    hasKeySpy.mockImplementation(throwStorageError)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await startPlanAudit(taskId)
      const output = errorSpy.mock.calls
        .flat()
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join('\n')
      expect(output).not.toContain(SENTINEL_PATH)
      expect(output).not.toContain(SENTINEL_SECRET)
      expect(output).not.toContain('EACCES')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('never reads the key value on this path either', async () => {
    const taskId = seedReviewableTask()
    hasKeySpy.mockImplementation(throwStorageError)

    await startPlanAudit(taskId)

    expect(readKeySpy).not.toHaveBeenCalled()
  })

  it('is RETRYABLE — the condition can clear on its own', () => {
    // Unlike the other provider codes, which need configuration or a reviewed
    // code change, this is environmental.
    expect(isRetryablePlanReviewReasonCode('provider_storage_unavailable')).toBe(true)
    expect(isRetryablePlanReviewReasonCode('credential_delivery_unavailable')).toBe(false)
    expect(isRetryablePlanReviewReasonCode('provider_not_configured')).toBe(false)
  })
})

describe('admission NEVER reads the key value', () => {
  it('does not call readAuditedCodexProviderKey with a key present', async () => {
    // THE P1 REGRESSION. An earlier revision resolved via a "is it readable?"
    // helper, which decrypted the key on every audit purely to choose between
    // two refusal codes — a real secret read in a path the contract says must
    // never touch the value.
    const taskId = seedReviewableTask()
    saveAuditedCodexProviderKey('provider-key')

    await startPlanAudit(taskId)

    expect(readKeySpy).not.toHaveBeenCalled()
  })

  it('does not call it on the default path either', async () => {
    const taskId = seedReviewableTask()

    await startPlanAudit(taskId)

    expect(readKeySpy).not.toHaveBeenCalled()
  })

  it('does not call it for a corrupt record', async () => {
    const taskId = seedReviewableTask()
    saveAuditedCodexProviderKey('provider-key')
    resetAuditedCodexProviderKeyCacheForTests()
    writeFileSync(
      join(orcaHome, '.orca', 'audited-workflow-codex-provider-token.enc'),
      'garbage',
      'utf8'
    )

    await startPlanAudit(taskId)

    expect(readKeySpy).not.toHaveBeenCalled()
  })
})

describe('clearing the key returns to default behaviour', () => {
  it('resolves to the default path again after a clear', async () => {
    const taskId = seedReviewableTask()
    saveAuditedCodexProviderKey('provider-key')
    clearAuditedCodexProviderKey()

    const result = await startPlanAudit(taskId)

    // Selection is derived, so clearing the key clears the provider.
    expect(result).toEqual({ ok: true })
    expect(codexRunner).toHaveBeenCalledTimes(1)
  })
})

describe('the settings field cannot activate or refuse', () => {
  it.each([
    ['an unknown settingsId', { settingsId: 'not-a-real-provider' }],
    ['a blank model', { settingsId: 'byesu', model: '   ' }],
    ['a corrupt shape', { nonsense: true }],
    ['an attacker endpoint', { settingsId: 'byesu', baseUrl: 'https://attacker.example/v1' }]
  ])('is INERT with no key: %s ⇒ default path, not a refusal', async (_label, planted) => {
    // The resolver never reads this field, so a hand-planted value must not
    // activate a provider AND must not manufacture provider_settings_invalid.
    const taskId = seedReviewableTask()
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET title = title WHERE id = ?`)
      .run(taskId)
    void planted

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({ ok: true })
    expect(codexRunner).toHaveBeenCalledTimes(1)
  })

  it('is INERT with a key: still credential_delivery_unavailable', async () => {
    const taskId = seedReviewableTask()
    saveAuditedCodexProviderKey('provider-key')

    const result = await startPlanAudit(taskId)

    // Identical to the no-settings case — the field changes nothing in either
    // direction.
    expect(result).toMatchObject({ reasonCode: 'credential_delivery_unavailable' })
  })
})

describe('capability-false invariant', () => {
  it('never spawns Codex while a provider key is configured', async () => {
    const taskId = seedReviewableTask()
    saveAuditedCodexProviderKey('provider-key')

    await startPlanAudit(taskId)

    // No code path may read the key for a launch or put it in a child
    // environment while delivery is disabled.
    expect(codexRunner).not.toHaveBeenCalled()
  })
})
