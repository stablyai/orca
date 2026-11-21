import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerWorktree,
  resolveWorkerWorktreeCreationTarget
} from './worker-worktree-creation'

function runtime() {
  return {
    showManagedWorktree: vi.fn(async (selector: string) => ({
      id: selector.slice('id:'.length),
      repoId: 'repo-caller'
    }))
  }
}

function target(
  callerWorktreeId: string,
  repo: string | undefined,
  requestedWorktree = 'new-child'
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution calls only showManagedWorktree.
  const fake = runtime() as never
  return resolveWorkerWorktreeCreationTarget({
    runtime: fake,
    requestedWorktree,
    repo,
    callerWorktreeId
  })
}

describe('resolveWorkerWorktreeCreationTarget from a folder caller', () => {
  it('creates from a worktree caller in its own repo unless told another', async () => {
    expect(await target('repo-caller::/wt', undefined)).toEqual({
      parentWorktreeId: 'repo-caller::/wt',
      repoSelector: 'repo-caller'
    })
  })

  it("creates from a folder caller, a bot's home say, in the repo it names", async () => {
    const fake = runtime()
    expect(
      await resolveWorkerWorktreeCreationTarget({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution calls only showManagedWorktree.
        runtime: fake as never,
        requestedWorktree: 'new-child',
        repo: 'path:/sandbox',
        callerWorktreeId: 'folder:bot-home'
      })
    ).toEqual({ parentFolderWorkspace: 'folder:bot-home', repoSelector: 'path:/sandbox' })
    expect(fake.showManagedWorktree).not.toHaveBeenCalled()
  })

  it('asks a folder caller for --repo instead of failing to find a worktree', async () => {
    await expect(target('folder:bot-home', undefined)).rejects.toThrow('--repo')
  })
})

describe('createWorkerWorktree lineage', () => {
  async function created(
    callerWorktreeId: string,
    requestedWorktree: 'new-child' | 'new-top-level'
  ) {
    const createManagedWorktree = vi.fn(async (_args: { lineage?: unknown }) => ({
      worktree: { id: 'repo-sandbox::/created', repoId: 'repo-sandbox' },
      startupTerminal: { spawned: true, handle: 'term_worker' }
    }))
    const host = {
      createManagedWorktree,
      showRepo: async () => ({ id: 'repo-sandbox', kind: 'git' }),
      listTerminals: async () => ({ terminals: [], totalCount: 0, truncated: false })
    }
    await createWorkerWorktree({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation calls only the methods faked here.
      runtime: host as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation records only worker stages.
      db: { recordWorkerStage: () => {} } as never,
      dispatchId: 'ctx_1',
      terminalTitle: 'Workspace task',
      requestedWorktree,
      target: await target(callerWorktreeId, 'path:/sandbox', requestedWorktree),
      orchestrationContext: { taskId: 'task_1', orchestrationRunId: 'run_1' },
      params: { name: 'ranger-hello', from: 'term_bot' },
      agent: 'claude',
      withAgentTerminal: true,
      effects: []
    })
    return createManagedWorktree.mock.calls[0]?.[0]
  }

  it("names a bot's home as the new workspace's parent, as the worker's", async () => {
    expect((await created('folder:bot-home', 'new-child'))?.lineage).toEqual({
      parentWorkspace: 'folder:bot-home',
      noParent: false,
      callerTerminalHandle: 'term_bot',
      orchestrationContext: { taskId: 'task_1', orchestrationRunId: 'run_1' }
    })
  })

  it('names a worktree caller the same way, and leaves new-top-level parentless', async () => {
    expect((await created('repo::/wt', 'new-child'))?.lineage).toMatchObject({
      parentWorktree: 'repo::/wt',
      noParent: false,
      orchestrationContext: { taskId: 'task_1', orchestrationRunId: 'run_1' }
    })
    const topLevel = (await created('folder:bot-home', 'new-top-level'))?.lineage
    expect(topLevel).toMatchObject({ noParent: true })
    expect(topLevel).not.toHaveProperty('parentWorkspace')
  })
})
