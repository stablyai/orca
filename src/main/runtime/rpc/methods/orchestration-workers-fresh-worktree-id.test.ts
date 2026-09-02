import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationError } from '../../orchestration/orchestration-error'
import { ORCHESTRATION_METHODS } from './orchestration'

// Regression for #17307: a reused terminal's pty can reincarnate into a
// different worktree without the leaf's static worktreeId ever catching up
// (recordPtyWorktree only updates ptysById). worker-start's ownership check
// must validate against the live (freshWorktreeId) value, not the stale one.
describe('orchestration worker-start: fresh worktree id (#17307)', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Test fresh worktree id',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === 'term_coord') {
        return { handle: 'term_coord', worktreeId: 'repo::target', status: 'running' } as never
      }
      // The reused worker terminal: its leaf was created in worktree-a, but its
      // pty has since reincarnated into worktree-target (e.g. a daemon restart).
      return {
        handle: 'term_worker',
        worktreeId: 'repo::worktree-a',
        freshWorktreeId: 'repo::target',
        status: 'running'
      } as never
    })
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::target',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  })

  afterEach(() => db.close())

  async function startWorker(overrides: Record<string, unknown> = {}) {
    const task = db.createTask({ spec: 'reuse-terminal task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      terminal: 'term_worker',
      ...overrides
    })
    return method.handler(params, { runtime })
  }

  it('does not reject a reused terminal whose live pty worktree matches the target, even though its leaf-derived worktreeId is stale', async () => {
    await expect(startWorker()).resolves.not.toThrow()
  })

  it('still rejects a reused terminal whose live pty worktree does not match the target', async () => {
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === 'term_coord') {
        return { handle: 'term_coord', worktreeId: 'repo::target', status: 'running' } as never
      }
      return {
        handle: 'term_worker',
        // Leaf-derived value happens to match the target, but the live pty does not.
        worktreeId: 'repo::target',
        freshWorktreeId: 'repo::elsewhere',
        status: 'running'
      } as never
    })

    await expect(startWorker()).rejects.toMatchObject({
      code: 'terminal_worktree_mismatch'
    } satisfies Partial<OrchestrationError>)
  })

  it('falls back to worktreeId when freshWorktreeId is absent (older host)', async () => {
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === 'term_coord') {
        return { handle: 'term_coord', worktreeId: 'repo::target', status: 'running' } as never
      }
      return { handle: 'term_worker', worktreeId: 'repo::elsewhere', status: 'running' } as never
    })

    await expect(startWorker()).rejects.toMatchObject({
      code: 'terminal_worktree_mismatch'
    } satisfies Partial<OrchestrationError>)
  })
})
