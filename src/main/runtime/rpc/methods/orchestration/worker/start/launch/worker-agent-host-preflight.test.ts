import { afterEach, expect, it, vi } from 'vitest'
import '../../../../../../orchestration/db/contract-constants'
import '../../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../../orchestration/db/attempt-outcome-projection'
import { createWorkerReleaseFixture } from '../../release/worker-release.test-fixture'
import { nameRefusingComputer } from './worker-agent-host-preflight'

afterEach(() => {
  vi.restoreAllMocks()
})

it('refuses a worker whose agent its computer lacks before any terminal or Dispatch exists', async () => {
  const { db, runtime, activeRunId, call } = createWorkerReleaseFixture()
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker start reads only the workspace and repo ids.
    { id: 'repo::worktree', repoId: 'repo' } as never
  )
  // The host's detection answer: only Claude is installed there.
  vi.spyOn(runtime, 'detectProjectLaunchContext').mockResolvedValue({
    agents: ['claude'],
    workspaceKind: 'git-worktree',
    executionContext: { kind: 'ssh' }
  })
  const task = db.createTask({ spec: 'needs codex', runId: activeRunId })

  const refused = await call('orchestration.workerStart', {
    task: task.id,
    from: 'term_coord',
    agent: 'codex'
  }).catch((error: unknown) => error)

  expect(refused).toMatchObject({
    code: 'worker_agent_unavailable',
    message: expect.stringContaining("Codex isn't installed on this computer")
  })
  expect(runtime.createTerminal).not.toHaveBeenCalled()
  expect(
    db.db.prepare('SELECT count(*) AS n FROM dispatch_contexts WHERE task_id = ?').get(task.id)
  ).toEqual({ n: 0 })
  // A paired server's refusal names that server, as this Orca calls it.
  expect(nameRefusingComputer(refused, 'g16')).toMatchObject({
    message: expect.stringContaining("Codex isn't installed on g16")
  })
  db.close()
})
