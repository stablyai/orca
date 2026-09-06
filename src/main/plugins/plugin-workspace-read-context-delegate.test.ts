import { describe, expect, it, vi } from 'vitest'
import type { PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { decoratePluginWorkspaceReadContext } from './plugin-workspace-read-context-delegate'

function delegate(
  context: Awaited<ReturnType<PluginRuntimeDelegate['resolveActiveWorktreeContext']>>
): PluginRuntimeDelegate {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(context),
    listTerminals: vi.fn(),
    sendTerminal: vi.fn(),
    dispatchPluginNotification: vi.fn()
  }
}

describe('decoratePluginWorkspaceReadContext', () => {
  it('projects SSH host and live agent labels onto the runtime context', async () => {
    const decorated = decoratePluginWorkspaceReadContext(
      delegate({
        worktreeId: 'wt-1',
        path: '/secret/repo',
        branch: 'main',
        displayName: 'Repo',
        hostId: 'ssh:build-box',
        createdWithAgent: 'codex'
      }),
      {
        hostLabelSources: () => ({
          hostLabelById: new Map([['ssh:build-box', 'Build box']])
        }),
        listAgentStatuses: () => [
          {
            worktreeId: 'wt-1',
            state: 'working',
            agentType: 'claude',
            model: 'opus-4',
            receivedAt: 2
          }
        ],
        getProfileLabel: () => 'Personal'
      }
    )

    await expect(decorated.resolveActiveWorktreeContext()).resolves.toMatchObject({
      worktreeId: 'wt-1',
      path: '/secret/repo',
      executionHost: { kind: 'ssh', label: 'Build box' },
      agent: { type: 'claude', model: 'opus-4', profile: 'Personal' }
    })
  })

  it('projects a missing host or agent field when the other is already set', async () => {
    const hostOnly = decoratePluginWorkspaceReadContext(
      delegate({
        worktreeId: 'wt-1',
        path: '/secret/repo',
        branch: 'main',
        displayName: 'Repo',
        hostId: 'ssh:build-box',
        createdWithAgent: 'codex',
        executionHost: { kind: 'ssh', label: 'Build box' }
      }),
      {
        hostLabelSources: () => ({
          hostLabelById: new Map([['ssh:build-box', 'Should not replace']])
        }),
        listAgentStatuses: () => [
          {
            worktreeId: 'wt-1',
            state: 'working',
            agentType: 'claude',
            model: 'opus-4',
            receivedAt: 2
          }
        ],
        getProfileLabel: () => 'Personal'
      }
    )
    await expect(hostOnly.resolveActiveWorktreeContext()).resolves.toMatchObject({
      executionHost: { kind: 'ssh', label: 'Build box' },
      agent: { type: 'claude', model: 'opus-4', profile: 'Personal' }
    })

    const agentOnly = decoratePluginWorkspaceReadContext(
      delegate({
        worktreeId: 'wt-1',
        path: '/secret/repo',
        branch: 'main',
        displayName: 'Repo',
        hostId: 'ssh:build-box',
        agent: { type: 'codex', model: null, profile: null }
      }),
      {
        hostLabelSources: () => ({
          hostLabelById: new Map([['ssh:build-box', 'Build box']])
        }),
        getProfileLabel: () => 'Should not replace'
      }
    )
    await expect(agentOnly.resolveActiveWorktreeContext()).resolves.toMatchObject({
      executionHost: { kind: 'ssh', label: 'Build box' },
      agent: { type: 'codex', model: null, profile: null }
    })
  })

  it('leaves an already-projected context unchanged', async () => {
    const existing = {
      worktreeId: 'wt-1',
      path: '/secret/repo',
      branch: 'main',
      displayName: 'Repo',
      executionHost: { kind: 'local' as const, label: 'Local Linux' },
      agent: { type: 'codex', model: null, profile: null }
    }
    const decorated = decoratePluginWorkspaceReadContext(delegate(existing), {
      getProfileLabel: () => 'Should not replace'
    })

    await expect(decorated.resolveActiveWorktreeContext()).resolves.toEqual(existing)
  })
})
