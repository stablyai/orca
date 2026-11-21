import { describe, expect, it } from 'vitest'
import {
  resolveRuntimeWorktreeCreateLineage,
  type ResolvedWorkspaceParent
} from './workspaces/lineage/runtime-worktree-lineage-resolution'

const BOT_HOME: ResolvedWorkspaceParent = {
  type: 'folder',
  workspaceKey: 'folder:bot-home',
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution only carries the record through.
  folderWorkspace: { id: 'bot-home' } as never,
  instanceId: null
}

const deps = {
  resolveParent: async () => BOT_HOME,
  resolveWorktreeParent: async () => BOT_HOME,
  resolveTaskCandidate: async () => null,
  resolveCaller: async () => ({ parent: BOT_HOME })
}

describe('resolveRuntimeWorktreeCreateLineage', () => {
  it("records a worker's named parent as the worker's, with its Task", async () => {
    const resolution = await resolveRuntimeWorktreeCreateLineage(
      {
        parentWorkspace: 'folder:bot-home',
        callerTerminalHandle: 'term_bot',
        orchestrationContext: { taskId: 'task_1', orchestrationRunId: 'run_1' }
      },
      deps
    )

    expect(resolution).toEqual({
      kind: 'lineage',
      parent: BOT_HOME,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      taskId: 'task_1',
      orchestrationRunId: 'run_1',
      createdByTerminalHandle: 'term_bot'
    })
  })

  it('keeps a plain named parent a CLI one', async () => {
    const resolution = await resolveRuntimeWorktreeCreateLineage(
      { parentWorkspace: 'folder:bot-home' },
      deps
    )

    expect(resolution).toMatchObject({ kind: 'lineage', origin: 'cli' })
    expect(resolution).not.toHaveProperty('taskId')
  })
})
