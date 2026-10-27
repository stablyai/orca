import { afterEach, describe, expect, it, vi } from 'vitest'
import { worktreeRemovedPayloadSchema } from '../../shared/plugins/plugin-events'
import type { PluginService } from '../plugins/plugin-service'
import { emitPluginWorktreeLifecycle } from './main-process-pty-startup'
import { mainProcessState } from './main-process-state'

describe('emitPluginWorktreeLifecycle', () => {
  afterEach(() => {
    mainProcessState.pluginService = null
  })

  it('keeps folder removals internal and publishes Git worktree removals', () => {
    const emitEvent = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the emitter only calls emitEvent.
    mainProcessState.pluginService = { emitEvent } as unknown as PluginService
    emitPluginWorktreeLifecycle({ kind: 'removed', worktreeId: 'folder:ws-1', path: '/tmp/ws' })
    expect(emitEvent).not.toHaveBeenCalled()
    emitPluginWorktreeLifecycle({ kind: 'removed', worktreeId: 'repo::/tmp/ws', path: '/tmp/ws' })
    expect(emitEvent).toHaveBeenCalledWith('worktree.removed', {
      worktreeId: 'repo::/tmp/ws',
      path: '/tmp/ws'
    })
    expect(worktreeRemovedPayloadSchema.safeParse(emitEvent.mock.calls[0]?.[1]).success).toBe(true)
  })
})
