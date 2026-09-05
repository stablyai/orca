import { describe, expect, it, vi } from 'vitest'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

function fixture() {
  const createTerminal = vi.fn(async (_selector: string, _options: TerminalCreateOptions) => ({
    handle: 'original-agent',
    tabId: 'agent-tab',
    worktreeId: 'workspace',
    title: null
  }))
  const activate = vi.fn()
  const deps = {
    store: {
      getSettings: () => ({ workspaceDir: '/workspaces' }),
      getProjectHostSetups: () => [],
      setWorktreeMeta: (_id: string, meta: object) => meta
    } as unknown as RuntimeStore,
    ptySpawnAvailable: true,
    createTerminal,
    markTrusted: vi.fn(async () => {}),
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    notifyWorktreesChanged: vi.fn(),
    emitCreated: vi.fn(),
    activate
  }
  const run = (activateStartup?: boolean, connectionId?: string) =>
    createRuntimeFolderWorktree({
      request: { repoSelector: 'repo', name: 'draft', runHooks: true, activate: true },
      repo: {
        id: 'repo',
        path: '/notes',
        displayName: 'Notes',
        badgeColor: '',
        addedAt: 0,
        kind: 'folder',
        ...(connectionId ? { connectionId } : {})
      },
      startup: {
        command: 'agent',
        ...(activateStartup !== undefined ? { activate: activateStartup } : {})
      },
      createdWithAgent: 'codex',
      deps
    })
  return { ...deps, run }
}

describe('folder workspace startup navigation', () => {
  it.each([undefined, 'ssh-host'])(
    'keeps background agent materialized without selecting on %s',
    async (connectionId) => {
      const f = fixture()
      const result = await f.run(false, connectionId)
      expect(f.activate).not.toHaveBeenCalled()
      expect(f.createTerminal).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.objectContaining({
          command: 'agent',
          activate: false,
          surfaceOwner: false
        })
      )
      expect(result.startupTerminal).toMatchObject({ spawned: true, handle: 'original-agent' })
    }
  )

  it.each([undefined, true])(
    'preserves existing activation with startupActivate=%s',
    async (activate) => {
      const f = fixture()
      await f.run(activate)
      expect(f.activate).toHaveBeenCalledOnce()
      expect(f.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('surfaceOwner')
    }
  )
})
