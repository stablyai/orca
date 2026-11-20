import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupRun } from '../../shared/workspace-cleanup/workspace-cleanup-run'
import { NO_WORKSPACE_CLEANUP_RULE_ON } from './workspace-cleanup-format'
import { WORKSPACE_CLEANUP_HANDLERS } from './workspace-cleanup'

const EMPTY_RUN: WorkspaceCleanupRun = {
  id: 'run-1',
  trigger: 'cli',
  startedAt: 0,
  finishedAt: 0,
  counts: { removed: 0, archived: 0, kept: 0, failed: 0 },
  freedBytes: 0,
  rows: []
}

function runCleanup(report: () => Promise<unknown>) {
  const call = vi.fn(async (method: string) =>
    method === 'workspaceCleanup.runNow' ? { id: '1', ok: true, result: EMPTY_RUN } : report()
  )
  return WORKSPACE_CLEANUP_HANDLERS['workspace cleanup run']({
    flags: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
    client: { call } as never,
    cwd: '/',
    json: false
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca workspace cleanup run', () => {
  it('prints a finished empty run when the follow-up report lookup fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCleanup(async () => {
      throw new Error('connection dropped')
    })

    expect(log).toHaveBeenCalledWith('Removed 0, kept 0, failed 0.')
  })

  it('says no rule is on when the report has no next run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCleanup(async () => ({ id: '2', ok: true, result: { nextRunAt: null } }))

    expect(log).toHaveBeenCalledWith(NO_WORKSPACE_CLEANUP_RULE_ON)
  })
})
