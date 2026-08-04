// IPC boundary for the plan-review lane.
//
// Two properties: the renderer can supply NOTHING but ids, and no raw error,
// path, or foreign artifact can escape through a handler.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const startPlanAudit = vi.fn()
const cancelPlanAudit = vi.fn()
const retryPlanAudit = vi.fn()
const approvePlanForImplementation = vi.fn()
const requestPlanRevisionAndStart = vi.fn()

vi.mock('../audited-workflow/audited-plan-review-orchestration', () => ({
  startPlanAudit: (...args: unknown[]) => startPlanAudit(...args),
  cancelPlanAudit: (...args: unknown[]) => cancelPlanAudit(...args),
  retryPlanAudit: (...args: unknown[]) => retryPlanAudit(...args),
  approvePlanForImplementation: (...args: unknown[]) => approvePlanForImplementation(...args),
  requestPlanRevisionAndStart: (...args: unknown[]) => requestPlanRevisionAndStart(...args)
}))

const getPlanArtifact = vi.fn()
vi.mock('../audited-workflow/audited-plan-artifact-repository', () => ({
  getPlanArtifact: (...args: unknown[]) => getPlanArtifact(...args)
}))

// The HASH-VERIFYING reader. The handler must use this one, not a plain read:
// the human must never be shown a body that differs from the bytes the artifact
// row — and therefore every downstream authorization — refers to.
const readVerifiedPlanArtifact = vi.fn()
vi.mock('../audited-workflow/audited-plan-artifact-store', () => ({
  readVerifiedPlanArtifact: (...args: unknown[]) => readVerifiedPlanArtifact(...args)
}))

vi.mock('../audited-workflow/audited-task-service', () => ({
  getAuditedTaskRepository: () => ({ getDatabase: () => ({}) })
}))

import { registerAuditedPlanReviewHandlers } from './audited-workflow-plan-review'

function invoke(channel: string, args: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, args)
}

/**
 * Zod validation failures surface as a synchronous throw from sync handlers and
 * as a rejection from async ones. Both are the same "caller programming error"
 * class, so the assertion accepts either rather than branching per channel.
 */
async function expectRejected(channel: string, args: unknown): Promise<void> {
  let threw = false
  try {
    await invoke(channel, args)
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerAuditedPlanReviewHandlers()
})

describe('parameter validation', () => {
  const TASK_ONLY_CHANNELS = [
    'auditedWorkflow:startPlanAudit',
    'auditedWorkflow:cancelPlanAudit',
    'auditedWorkflow:retryPlanAudit',
    'auditedWorkflow:approvePlan',
    'auditedWorkflow:requestPlanRevision'
  ]

  it.each(TASK_ONLY_CHANNELS)(
    '%s rejects an extra key rather than stripping it',
    async (channel) => {
      // A stripped key would hide a caller bug AND let a renderer believe it had
      // influenced the launch. .strict() makes it a hard error.
      await expectRejected(channel, { taskId: 't1', model: 'evil-model' })
    }
  )

  it.each(TASK_ONLY_CHANNELS)('%s rejects a missing taskId', async (channel) => {
    await expectRejected(channel, {})
  })

  it('getPlanArtifact rejects extra keys', async () => {
    await expectRejected('auditedWorkflow:getPlanArtifact', {
      taskId: 't1',
      artifactId: 'plan_a',
      path: '/etc/passwd'
    })
  })
})

describe('error redaction', () => {
  it('converts an unexpected throw into a closed code', async () => {
    startPlanAudit.mockRejectedValue(new Error('C:\\Users\\alice\\secret\\path exploded'))
    const result = await invoke('auditedWorkflow:startPlanAudit', { taskId: 't1' })
    expect(result).toEqual({ ok: false, kind: 'planReview', reasonCode: 'spawn_failed' })
    expect(JSON.stringify(result)).not.toContain('alice')
  })

  it('converts an approve throw into a closed code', () => {
    approvePlanForImplementation.mockImplementation(() => {
      throw new Error('/home/bob/db locked')
    })
    const result = invoke('auditedWorkflow:approvePlan', { taskId: 't1' })
    expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
  })

  it('passes a structured orchestration failure through unchanged', async () => {
    startPlanAudit.mockResolvedValue({
      ok: false,
      kind: 'planReview',
      reasonCode: 'artifact_superseded'
    })
    expect(await invoke('auditedWorkflow:startPlanAudit', { taskId: 't1' })).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'artifact_superseded'
    })
  })
})

describe('getPlanArtifact ownership', () => {
  it('serves an artifact that belongs to the task', () => {
    getPlanArtifact.mockReturnValue({
      id: 'plan_a',
      taskId: 't1',
      truncated: true,
      redactionCount: 2,
      round: 1,
      status: 'current'
    })
    readVerifiedPlanArtifact.mockReturnValue({ ok: true, text: 'the plan body' })

    expect(
      invoke('auditedWorkflow:getPlanArtifact', { taskId: 't1', artifactId: 'plan_a' })
    ).toEqual({
      ok: true,
      text: 'the plan body',
      truncated: true,
      redactionCount: 2,
      round: 1,
      status: 'current'
    })
  })

  // The property that stops this becoming a cross-task read primitive.
  it('refuses an artifact belonging to ANOTHER task', () => {
    getPlanArtifact.mockReturnValue({
      id: 'plan_a',
      taskId: 'someone-else',
      truncated: false,
      redactionCount: 0,
      round: 0,
      status: 'current'
    })
    readVerifiedPlanArtifact.mockReturnValue({ ok: true, text: 'secret plan' })

    const result = invoke('auditedWorkflow:getPlanArtifact', {
      taskId: 't1',
      artifactId: 'plan_a'
    })
    expect(result).toEqual({ ok: false, reasonCode: 'artifact_unavailable' })
    // The body must never have been read at all.
    expect(readVerifiedPlanArtifact).not.toHaveBeenCalled()
  })

  it('refuses an unknown artifact', () => {
    getPlanArtifact.mockReturnValue(null)
    expect(
      invoke('auditedWorkflow:getPlanArtifact', { taskId: 't1', artifactId: 'plan_missing' })
    ).toEqual({ ok: false, reasonCode: 'artifact_unavailable' })
  })

  it('serves a SUPERSEDED artifact so earlier rounds stay readable', () => {
    getPlanArtifact.mockReturnValue({
      id: 'plan_old',
      taskId: 't1',
      truncated: false,
      redactionCount: 0,
      round: 0,
      status: 'superseded'
    })
    readVerifiedPlanArtifact.mockReturnValue({ ok: true, text: 'the old plan' })
    expect(
      invoke('auditedWorkflow:getPlanArtifact', { taskId: 't1', artifactId: 'plan_old' })
    ).toMatchObject({ ok: true, status: 'superseded' })
  })

  it('verifies the body against the artifact hash before returning it', () => {
    getPlanArtifact.mockReturnValue({
      id: 'plan_a',
      taskId: 't1',
      contentSha256: 'expected-hash',
      truncated: false,
      redactionCount: 0,
      round: 0,
      status: 'current'
    })
    readVerifiedPlanArtifact.mockReturnValue({ ok: true, text: 'body' })

    invoke('auditedWorkflow:getPlanArtifact', { taskId: 't1', artifactId: 'plan_a' })

    // The row's hash is what the read is checked against — a plain read would
    // happily return a tampered body.
    expect(readVerifiedPlanArtifact).toHaveBeenCalledWith(
      expect.any(String),
      'plan_a',
      'expected-hash'
    )
  })

  it('returns NO body when the file no longer matches the artifact hash', () => {
    getPlanArtifact.mockReturnValue({
      id: 'plan_a',
      taskId: 't1',
      contentSha256: 'expected-hash',
      truncated: false,
      redactionCount: 0,
      round: 0,
      status: 'current'
    })
    // A tampered file: readable, but not the reviewed bytes.
    readVerifiedPlanArtifact.mockReturnValue({ ok: false, reasonCode: 'artifact_superseded' })

    const result = invoke('auditedWorkflow:getPlanArtifact', {
      taskId: 't1',
      artifactId: 'plan_a'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'artifact_unavailable' })
    // No altered body crosses IPC under any key.
    expect(JSON.stringify(result)).not.toContain('text')
  })

  it('fails closed when the body cannot be read', () => {
    getPlanArtifact.mockReturnValue({
      id: 'plan_a',
      taskId: 't1',
      truncated: false,
      redactionCount: 0,
      round: 0,
      status: 'current'
    })
    readVerifiedPlanArtifact.mockReturnValue({ ok: false, reasonCode: 'artifact_unavailable' })
    expect(
      invoke('auditedWorkflow:getPlanArtifact', { taskId: 't1', artifactId: 'plan_a' })
    ).toEqual({ ok: false, reasonCode: 'artifact_unavailable' })
  })
})
