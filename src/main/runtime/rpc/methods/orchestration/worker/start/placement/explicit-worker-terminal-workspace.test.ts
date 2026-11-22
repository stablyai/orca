import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../../testing/worker-release.test-support'

describe('worker-start --terminal in another workspace than the coordinator', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  function setupTerminalInOtherWorkspace(): void {
    h.setup()
    const terminal = vi.mocked(h.runtime.showTerminal)
    const showTerminal = terminal.getMockImplementation()
    const workspace = vi.mocked(h.runtime.showManagedTerminalWorkspace)
    const showWorkspace = workspace.getMockImplementation()
    if (!showTerminal || !showWorkspace) {
      throw new Error('worker harness must mock terminal and workspace lookups')
    }
    terminal.mockImplementation(async (handle) => ({
      ...(await showTerminal(handle)),
      worktreeId: handle === 'term_coord' ? 'repo::coordinator' : 'repo::user-tab'
    }))
    workspace.mockImplementation(async (selector) => ({
      ...(await showWorkspace(selector)),
      id: selector.replace(/^id:/, '')
    }))
  }

  const start = (worktree?: string) =>
    h.call('orchestration.workerStart', {
      from: 'term_coord',
      terminal: 'term_worker',
      spec: 'build the study guide',
      ...(worktree ? { worktree } : {})
    })

  it("starts in the terminal's own workspace when --worktree is omitted", async () => {
    setupTerminalInOtherWorkspace()

    await expect(start()).resolves.toMatchObject({
      state: 'ready',
      effects: expect.arrayContaining([
        { kind: 'worktree', action: 'reused', id: 'repo::user-tab' }
      ])
    })
  })

  it('still refuses an explicit --worktree the terminal is not in', async () => {
    setupTerminalInOtherWorkspace()

    await expect(start('current')).rejects.toMatchObject({
      code: 'terminal_worktree_mismatch',
      message: 'Terminal term_worker does not belong to worktree repo::coordinator.'
    })
  })
})
