import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { registerWorktreeMetadataHandlers } from './register-worktree-metadata-handlers'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

const setWorktreeMeta = vi.fn((_target: unknown, meta: unknown) => meta)

function updateMeta(workspaceUrl: string): unknown {
  return handlers.get('worktrees:updateMeta')!(null, {
    worktreeId: 'repo-1::/workspace/feature-wt',
    executionHostId: 'ssh:build-box',
    updates: { workspaceUrl }
  })
}

describe('worktrees:updateMeta workspace link', () => {
  beforeEach(() => {
    handlers.clear()
    setWorktreeMeta.mockClear()
    registerWorktreeMetadataHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updateMeta path only reads these store methods.
      {
        store: { setWorktreeMeta, getRepos: () => [] },
        runtime: {}
      } as unknown as WorktreeIpcContext
    )
  })

  it('rejects a link that is not http(s)', () => {
    expect(() => updateMeta('file:///etc/passwd')).toThrow('Invalid workspace URL.')
    expect(() => updateMeta('javascript:alert(1)')).toThrow('Invalid workspace URL.')
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('saves an http(s) link and clears it with an empty string', () => {
    for (const workspaceUrl of ['https://app.test/admin', '']) {
      updateMeta(workspaceUrl)
      expect(setWorktreeMeta).toHaveBeenLastCalledWith(expect.anything(), { workspaceUrl })
    }
  })
})
