import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceRemovedPayloadSchema } from '../../shared/plugins/events/plugin-events'
import type { PluginService } from '../plugins/plugin-service'
import { emitPluginWorktreeLifecycle } from './main-process-pty-startup'
import { mainProcessState } from './main-process-state'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'

describe('emitPluginWorktreeLifecycle', () => {
  afterEach(() => {
    mainProcessState.pluginService = null
    setPluginHookRunner(null)
  })

  it.each([
    { worktreeId: 'folder:ws-1', branch: '' },
    { worktreeId: 'folder-repo::/ws::workspace:instance', branch: 'Workspace', folder: true }
  ])('keeps folder creation internal: $worktreeId', (workspace) => {
    const emitEvent = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the emitter only calls emitEvent.
    mainProcessState.pluginService = { emitEvent } as unknown as PluginService
    const run = vi.fn(async (_event: string, payload: unknown) => ({
      kind: 'continue' as const,
      payload
    }))
    setPluginHookRunner({ wants: () => true, run })
    emitPluginWorktreeLifecycle({
      kind: 'created',
      path: '/ws',
      ...workspace
    })
    expect(emitEvent).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith('workspace.create.after', {
      workspaceId: workspace.worktreeId,
      kind: 'folder',
      path: '/ws',
      branch: ''
    })
  })

  it('keeps folder removals internal and publishes Git worktree removals', () => {
    const emitEvent = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the emitter only calls emitEvent.
    mainProcessState.pluginService = { emitEvent } as unknown as PluginService
    emitPluginWorktreeLifecycle({ kind: 'removed', worktreeId: 'folder:ws-1', path: '/tmp/ws' })
    expect(emitEvent).not.toHaveBeenCalled()
    emitPluginWorktreeLifecycle({ kind: 'removed', worktreeId: 'repo::/tmp/ws', path: '/tmp/ws' })
    expect(emitEvent).toHaveBeenCalledWith('workspace.removed', {
      workspaceId: 'repo::/tmp/ws',
      kind: 'worktree',
      path: '/tmp/ws'
    })
    expect(workspaceRemovedPayloadSchema.safeParse(emitEvent.mock.calls[0]?.[1]).success).toBe(true)
  })
})
