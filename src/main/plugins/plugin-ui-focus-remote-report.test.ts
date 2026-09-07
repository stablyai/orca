import { describe, expect, it, vi } from 'vitest'
import { PluginEventBus } from './plugin-event-bus'
import { PluginUiFocusSnapshot } from './plugin-ui-focus'
import {
  reportPluginServiceUiFocus,
  type PluginServiceHostCallContext
} from './plugin-service-host-calls'

function context(
  uiFocus: PluginUiFocusSnapshot,
  emit: PluginServiceHostCallContext['eventBus']
): PluginServiceHostCallContext {
  return {
    userDataPath: '/tmp',
    isPluginSystemEnabled: () => true,
    disposed: false,
    discovered: [],
    eventBus: emit,
    workerController: { ensure: vi.fn(), deliverEventIfRunning: vi.fn() } as never,
    audit: { record: vi.fn() } as never,
    logBuffer: { append: vi.fn() } as never,
    runtimeDelegate: null,
    uiFocus,
    sidecarMailbox: {} as never,
    getGrantedCapabilities: () => null,
    isRuntimeApproved: () => false
  }
}

describe('remote UI focus report on the runtime host', () => {
  it('projects join keys from a paired-client report and emits once', () => {
    const snapshot = new PluginUiFocusSnapshot()
    const eventBus = new PluginEventBus()
    const project = vi.spyOn(eventBus, 'projectPayload')
    const ctx = context(snapshot, eventBus)

    reportPluginServiceUiFocus(ctx, {
      windowFocused: true,
      kind: 'agent',
      title: '/Users/private/repo/secret.ts',
      worktreeId: 'repo-1::/Users/private/orca',
      agentId: 'tab-agent-1'
    })

    expect(snapshot.get()).toEqual({
      kind: 'agent',
      title: 'secret.ts',
      worktreeId: 'pj_1',
      agentId: 'tab-agent-1'
    })
    expect(snapshot.get()?.worktreeId).not.toContain('/')
    expect(project).toHaveBeenCalledWith(
      'ui.focus.changed',
      expect.objectContaining({
        focusedSurface: {
          kind: 'agent',
          title: 'secret.ts',
          worktreeId: 'pj_1',
          agentId: 'tab-agent-1'
        }
      })
    )
    expect(project.mock.results[0]?.value).toMatchObject({ ok: true })

    reportPluginServiceUiFocus(ctx, {
      windowFocused: true,
      kind: 'agent',
      title: '/Users/private/repo/secret.ts',
      worktreeId: 'repo-1::/Users/private/orca',
      agentId: 'tab-agent-1'
    })
    expect(project).toHaveBeenCalledTimes(1)
  })
})
