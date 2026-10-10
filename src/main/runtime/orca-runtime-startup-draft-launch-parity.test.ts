import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  ensurePathWithinWorkspaceMock,
  listWorktrees
} from './orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from './orca-runtime-test-mocks.spec'
import { makeWorktreeMeta, store } from './orca-runtime-test-fixtures.spec'
import { createWorktreeWithStartupAgent } from '../agent-launch/startup-agent-worktree-create'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

type DraftSettings = {
  defaultTuiAgent: 'claude' | null
  agentDefaultArgs: Record<string, string>
  detected: string[]
}

/** One create on a fresh runtime: what the user is left with, and how often agents were detected. */
async function runCreate(
  route: 'create' | 'launch',
  settings: DraftSettings,
  request: Omit<RuntimeManagedWorktreeCreateArgs, 'repoSelector' | 'name'>
) {
  detectInstalledAgentsWithShellPathHydrationMock.mockReset()
  detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(settings.detected)
  detectRemoteAgentsMock.mockClear()
  const metaById: Record<string, WorktreeMeta> = {}
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({
      ...store.getSettings(),
      defaultTuiAgent: settings.defaultTuiAgent,
      agentCmdOverrides: {},
      agentDefaultArgs: settings.agentDefaultArgs
    }),
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
    setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    }
  })
  const spawn = vi.fn().mockResolvedValue({ id: `pty-${route}` })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const path = `/tmp/workspaces/draft-parity-${route}`
  computeWorktreePathMock.mockReturnValue(path)
  ensurePathWithinWorkspaceMock.mockReturnValue(path)
  vi.mocked(listWorktrees).mockResolvedValue([
    { path, head: 'abc', branch: 'draft-parity', isBare: false, isMainWorktree: false }
  ])
  const args = { repoSelector: 'id:repo-1', name: 'draft-parity', ...request }
  const result =
    route === 'create'
      ? await runtime.createManagedWorktree(args)
      : await createWorktreeWithStartupAgent(runtime, args)
  return {
    createdWithAgent: metaById[result.worktree.id]?.createdWithAgent,
    spawned: spawn.mock.calls.map(([options]) => options.command ?? null),
    detections: detectInstalledAgentsWithShellPathHydrationMock.mock.calls.length
  }
}

const DRAFT = 'https://github.com/stablyai/orca/issues/123'

// `worktree.create` now reaches the create through the launch executor; for a linked draft the
// user must be left with exactly what the create alone gave them.
describe('a linked-draft create through the launch executor', () => {
  it.each([false, true])(
    'matches the create when the default agent cannot be launched (activate %s)',
    async (activate) => {
      const settings = {
        defaultTuiAgent: 'claude' as const,
        agentDefaultArgs: { claude: '--foo "unbalanced' },
        detected: []
      }
      const request = { startupDraft: DRAFT, activate }

      const before = await runCreate('create', settings, request)
      const after = await runCreate('launch', settings, request)

      expect(after).toEqual(before)
      // No agent started, so none is recorded and a background create still opens its shell.
      expect(before.createdWithAgent).toBeUndefined()
      if (!activate) {
        expect(before.spawned).toHaveLength(1)
      }
    }
  )

  it('detects once and starts the detected agent with the draft, as the create does', async () => {
    const settings = { defaultTuiAgent: null, agentDefaultArgs: {}, detected: ['claude'] }
    const request = { startupDraft: DRAFT, activate: false }

    const before = await runCreate('create', settings, request)
    const after = await runCreate('launch', settings, request)

    expect(after).toEqual(before)
    expect(before.detections).toBe(1)
    expect(before.createdWithAgent).toBe('claude')
    expect(before.spawned).toEqual([expect.stringContaining(DRAFT)])
  })

  it('detects once when no agent is found, and records none', async () => {
    const settings = { defaultTuiAgent: null, agentDefaultArgs: {}, detected: [] }
    const request = { startupDraft: DRAFT, activate: false }

    const before = await runCreate('create', settings, request)
    const after = await runCreate('launch', settings, request)

    expect(after).toEqual(before)
    expect(before.detections).toBe(1)
    expect(before.createdWithAgent).toBeUndefined()
  })

  it('keeps a requested agent the request named, without detecting', async () => {
    const settings = { defaultTuiAgent: null, agentDefaultArgs: {}, detected: ['codex'] }
    const request = { startupDraft: DRAFT, createdWithAgent: 'claude' as const, activate: false }

    const before = await runCreate('create', settings, request)
    const after = await runCreate('launch', settings, request)

    expect(after).toEqual(before)
    expect(before.detections).toBe(0)
    expect(before.createdWithAgent).toBe('claude')
  })
})
