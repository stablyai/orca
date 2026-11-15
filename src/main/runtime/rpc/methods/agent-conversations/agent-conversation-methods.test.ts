import { expect, it, vi } from 'vitest'
import { AGENT_CONVERSATION_METHODS } from './agent-conversation-methods'
import { buildRuntimeWorktreePsSummaries } from '../../../workspaces/process-listing/runtime-worktree-ps-summaries'
import type { RpcContext } from '../../core'

vi.mock('../../../../agent-hooks/server/agent-hook-server', () => ({ agentHookServer: {} }))

it.each([750, 7_500])(
  'constructs only the selected workspace among %i git and folder workspaces',
  async (n) => {
    let summariesBuilt = 0
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `repo::/repo/w${i}`,
      repoId: 'repo',
      path: `/repo/w${i}`,
      branch: `w${i}`,
      hostId: 'local',
      parentWorktreeId: null,
      childWorktreeIds: [],
      get displayName() {
        summariesBuilt++
        return `w${i}`
      }
    }))
    const folders = Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      projectGroupId: 'group',
      folderPath: `/folders/f${i}`,
      executionHostId: 'local',
      get name() {
        summariesBuilt++
        return `f${i}`
      }
    }))
    const store = {
      getRepos: () => [
        { id: 'repo', path: '/repo', displayName: 'Repo', executionHostId: 'local' }
      ],
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => folders,
      getProjectGroups: () => [{ id: 'group', name: 'Folders', parentPath: '/folders' }]
    }
    const runtime = {
      getWorktreePs: async (
        _limit: number,
        _defaults?: boolean,
        _wait?: boolean,
        worktreeId?: string
      ) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these fixtures supply every summary-builder field read on this path.
        const args = {
          store,
          resolvedWorktrees: rows,
          platformByRepoId: new Map(),
          worktreeId
        } as unknown as Parameters<typeof buildRuntimeWorktreePsSummaries>[0]
        const summaries = buildRuntimeWorktreePsSummaries(args)
        for (const row of summaries.values()) {
          row.agents = [
            {
              paneKey: 'tab:1',
              parentPaneKey: null,
              prompt: '',
              toolName: null,
              toolInput: null,
              interrupted: false,
              stateStartedAt: 1,
              agentType: 'claude',
              state: 'done',
              lastAssistantMessage: 'done',
              displayName: null,
              taskTitle: null,
              updatedAt: 1
            }
          ]
        }
        return { worktrees: [...summaries.values()], truncated: false }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent.list only uses this context's real summary-backed getWorktreePs.
    const ctx = { runtime } as unknown as RpcContext
    const method = AGENT_CONVERSATION_METHODS.find((entry) => entry.name === 'agent.list')
    if (!method) {
      throw new Error('agent.list is missing')
    }
    for (const worktreeId of ['repo::/repo/w0', 'folder:f0']) {
      summariesBuilt = 0
      const result = await method.handler({ worktreeId }, ctx)
      expect(result.agents).toMatchObject([{ worktreeId, lastAssistantMessage: 'done' }])
      expect(result.agents).toHaveLength(1)
      expect(summariesBuilt).toBe(1)
    }
  }
)
