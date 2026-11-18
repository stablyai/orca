import { describe, expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../construction/test-context/runtime-store-partial-fixture'
import { BotWorktreeLineageController } from './runtime-bot-worktree-lineage-controller'
import { folderSelectorResolver } from './runtime-bot-lineage.test-fixture'
import type { WorktreeLineageInput } from './runtime-worktree-lineage-resolution'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type { CliWorktreeBuilder } from '../../rpc/methods/agent-launch/agent-launch-cwd-cli.test-fixture'
import {
  makeRuntimeOrchestrationDb,
  taskLineageRow
} from '../../orchestration/db/runtime-orchestration-db.test-fixture'

const BOT_HOME = storeFolderWorkspace({ id: 'scout-home', projectGroupId: 'g', folderPath: '/s' })
const OTHER = storeFolderWorkspace({ id: 'notes', projectGroupId: 'g', folderPath: '/n' })
const SESSION_WORKSPACES: Record<string, string> = {
  'bot-chat': folderWorkspaceKey(BOT_HOME.id),
  'plain-chat': folderWorkspaceKey(OTHER.id)
}
const TERMINAL_WORKSPACES: Record<string, string> = {
  term_bot: folderWorkspaceKey(BOT_HOME.id)
}

function resolveCreate(input: WorktreeLineageInput) {
  const controller = new BotWorktreeLineageController({
    getStore: () =>
      partialRuntimeStore({
        getBots: () => [makeTestBot({ folderWorkspaceId: BOT_HOME.id })],
        getFolderWorkspaces: () => [BOT_HOME, OTHER]
      }),
    getDb: () => null,
    resolveWorkspace: folderSelectorResolver([BOT_HOME, OTHER]),
    showTerminal: async (handle) => {
      const worktreeId = TERMINAL_WORKSPACES[handle]
      if (!worktreeId) {
        throw new Error('terminal_handle_stale')
      }
      return { worktreeId }
    },
    getSessionWorkspaceKey: async (sessionId) => {
      const workspaceKey = SESSION_WORKSPACES[sessionId]
      if (!workspaceKey) {
        throw new Error('unknown session')
      }
      return workspaceKey
    }
  })
  return controller.resolveCreate(input)
}

const BOT_OWNED = {
  kind: 'lineage',
  parent: expect.objectContaining({ workspaceKey: folderWorkspaceKey(BOT_HOME.id) }),
  origin: 'orchestration'
}

describe('bot-created worktree lineage', () => {
  it('files a bot chat create under the bot even when its agent passes --no-parent', async () => {
    const resolution = await resolveCreate({ noParent: true, callerAgentSessionId: 'bot-chat' })
    expect(resolution).toMatchObject(BOT_OWNED)
  })

  it('files a bot chat create with no parent context under the bot', async () => {
    await expect(resolveCreate({ callerAgentSessionId: 'bot-chat' })).resolves.toMatchObject(
      BOT_OWNED
    )
  })

  it('files a create from a terminal in the bot home under the bot', async () => {
    await expect(
      resolveCreate({ noParent: true, callerTerminalHandle: 'term_bot' })
    ).resolves.toMatchObject(BOT_OWNED)
  })

  it('turns an explicit bot-home parent into the bot link', async () => {
    await expect(
      resolveCreate({
        parentWorkspace: folderWorkspaceKey(BOT_HOME.id),
        callerAgentSessionId: 'bot-chat'
      })
    ).resolves.toMatchObject(BOT_OWNED)
  })

  it('keeps an explicit other parent the bot chose', async () => {
    await expect(
      resolveCreate({
        parentWorkspace: folderWorkspaceKey(OTHER.id),
        callerAgentSessionId: 'bot-chat'
      })
    ).resolves.toMatchObject({
      kind: 'lineage',
      parent: { workspaceKey: folderWorkspaceKey(OTHER.id) },
      origin: 'cli'
    })
  })

  it('leaves creates from sessions outside a bot home alone', async () => {
    await expect(
      resolveCreate({ noParent: true, callerAgentSessionId: 'plain-chat' })
    ).resolves.toEqual({ kind: 'none', warnings: [] })
    await expect(
      resolveCreate({ noParent: true, callerTerminalHandle: 'term_stale' })
    ).resolves.toEqual({ kind: 'none', warnings: [] })
  })
})

const fixturesPath = '../../../../cli/runtime/fixtures/runtime-rpc-fixtures'
const { buildWorktree }: { buildWorktree: CliWorktreeBuilder } = await import(fixturesPath)

function resolvedWorktree(id: string): ResolvedWorktree {
  const built: Omit<ReturnType<CliWorktreeBuilder>, 'identity'> = buildWorktree(
    '/tmp/parent',
    'main',
    'abc',
    'repo-a'
  )
  return {
    ...built,
    ...built.git,
    id,
    hostId: 'local',
    instanceId: id,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

describe('bot lineage controller hydration', () => {
  it('retries a caller terminal lookup that failed on an earlier hydration', async () => {
    const db = makeRuntimeOrchestrationDb()
    vi.spyOn(db, 'getDispatchContext').mockReturnValue(undefined)
    vi.spyOn(db, 'getTask').mockReturnValue(
      taskLineageRow({ id: 'task_parent', created_by_terminal_handle: 'term_parent' })
    )
    const showTerminal = vi
      .fn<(handle: string) => Promise<{ worktreeId: string }>>()
      .mockRejectedValueOnce(new Error('runtime_unavailable'))
      .mockResolvedValue({ worktreeId: 'wt-parent' })
    const controller = new BotWorktreeLineageController({
      getStore: () => null,
      getDb: () => db,
      resolveWorkspace: async (selector) => ({
        kind: 'worktree',
        worktree: resolvedWorktree(selector.slice(3))
      }),
      showTerminal,
      getSessionWorkspaceKey: async () => {
        throw new Error('unknown session')
      }
    })

    expect(await controller.resolveTaskCandidate('task_parent')).toBeNull()
    expect(await controller.resolveTaskCandidate('task_parent')).toMatchObject({
      source: 'orchestration-context',
      parent: { workspaceKey: 'worktree:wt-parent' }
    })
  })
})
