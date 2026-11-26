import { afterEach, expect, it, vi } from 'vitest'
import '../../../../../../orchestration/db/contract-constants'
import '../../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../../orchestration/db/attempt-outcome-projection'
import { createWorkerReleaseFixture } from '../../release/worker-release.test-fixture'
import { nameRefusingComputer, preflightWorkerAgentOnHost } from './worker-agent-host-preflight'

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

/** A host whose repo `repo` has Claude installed, and whose chat support for it is `support`. */
function repoHost(support: { supported: boolean; reason?: 'agent' }) {
  const asked: string[] = []
  const runtime = {
    getStructuredAgentSessionCreateSupport: async (place: string | { repo: string }) => {
      // A workspace about to be created has no worktree to ask about, only its repo.
      if (typeof place === 'string') {
        throw new Error(`asked about a worktree: ${place}`)
      }
      asked.push(place.repo)
      return support
    },
    detectProjectLaunchContext: async () => ({
      agents: ['claude' as const],
      workspaceKind: 'git-worktree' as const,
      executionContext: { kind: 'ssh' as const }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight reads only these runtime methods.
  return { runtime: runtime as never, asked }
}

const DEFAULT_CHAT = {
  mode: 'structured' as const,
  preferred: 'structured' as const,
  reason: 'user_default' as const,
  detail: 'chat'
}

it("reads a new workspace's chat support from the repo it will be created in, before creating it", async () => {
  const { runtime, asked } = repoHost({ supported: false, reason: 'agent' })
  const mode = await preflightWorkerAgentOnHost({
    runtime,
    mode: DEFAULT_CHAT,
    agent: 'claude',
    creationTarget: { repoSelector: 'repo' }
  })
  expect(asked).toEqual(['repo'])
  // A CLI too old for chats falls back to a terminal before any workspace exists.
  expect(mode.mode).toBe('terminal')
})

it("refuses a new workspace's chat worker whose agent the repo's computer lacks", async () => {
  const { runtime } = repoHost({ supported: true })
  const refused = await preflightWorkerAgentOnHost({
    runtime,
    mode: DEFAULT_CHAT,
    agent: 'codex',
    creationTarget: { repoSelector: 'repo' }
  }).catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: 'worker_agent_unavailable' })
})
