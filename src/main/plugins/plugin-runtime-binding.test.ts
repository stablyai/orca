import { describe, expect, it, vi } from 'vitest'
import { createPluginAgentStatusForwarder, pluginRuntimeDelegate } from './plugin-runtime-binding'

import { PluginPanelBridge } from './panels/plugin-panel-bridge'
import type { AgentStatusOrchestrationContext } from '../../shared/agent-status/contracts/agent-status-types'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

const LEAF = '11111111-1111-4111-8111-111111111111'

function runtime(terminals: { handle: string; title: string | null; paneTitle?: string }[]) {
  return {
    resolveActiveWorktreeContext: vi.fn(async () => ({
      worktreeId: 'repo::/w',
      path: '/w',
      branch: 'refs/heads/main',
      displayName: 'w'
    })),
    listTerminals: vi.fn(async () => ({
      terminals: terminals.map((terminal, index) => ({
        ...terminal,
        tabId: `tab${index}`,
        leafId: LEAF
      }))
    })),
    sendTerminal: vi.fn(),
    dispatchPluginNotification: vi.fn(),
    listAgentTasksByPaneKey: vi.fn((): Record<string, AgentStatusOrchestrationContext> => ({
      'tab0:worker': {
        taskId: 't-1',
        dispatchId: 'd-1',
        dispatchStatus: 'dispatched',
        taskTitle: 'Write the tests',
        coordinatorHandle: 'h'
      },
      'tab0:untitled': { taskId: 't-2', dispatchId: 'd-2' },
      'tab0:finished': {
        taskId: 't-3',
        dispatchId: 'd-3',
        dispatchStatus: 'completed',
        taskTitle: 'Done'
      }
    }))
  }
}

describe('agent.status.changed for plugins', () => {
  it('serves several open panels, and stops looking up only when the last one closes', async () => {
    const plugin = { pluginKey: 'acme.board', manifest: {} }
    const bridge = new PluginPanelBridge({
      findApprovedPlugin: (key) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishEvent reads only pluginKey.
        key === plugin.pluginKey ? (plugin as never as ValidDiscoveredPlugin) : null,
      grantedCapabilities: () => ['agent:read'],
      ensureWorker: async () => {
        throw new Error('no worker')
      },
      runningWorker: () => null,
      log: () => () => undefined,
      now: () => 0
    })
    const panels = ['panel-a', 'panel-b'].map((id) => {
      const deliver = vi.fn()
      bridge.open({ id, surface: 'panel', contributionId: 'board' }, plugin.pluginKey, deliver)
      bridge.subscribe(plugin.pluginKey, id, 'agent.status.changed')
      return deliver
    })
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    const listing = Promise.withResolvers<{ terminals: [] }>()
    source.listTerminals.mockReturnValueOnce(listing.promise)
    const forward = createPluginAgentStatusForwarder(
      pluginRuntimeDelegate(source, () => []),
      {
        wantsEvent: (event) => bridge.hasSubscribers(event),
        emitEvent: (event, payload) => void bridge.publishEvent(event, payload)
      }
    )
    const base = { state: 'working' as const, receivedAt: 1, paneKey: `tab0:${LEAF}` }
    forward({ ...base, workspaceId: 'repo::/a' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledOnce())
    forward({ ...base, workspaceId: 'repo::/b' })
    bridge.close('panel-a')
    listing.resolve({ terminals: [] })
    await vi.waitFor(() => expect(panels[1]).toHaveBeenCalledTimes(2))
    expect(panels[0]).not.toHaveBeenCalled()
    // Last panel closes with events queued behind a slow lookup: the backlog is dropped.
    const slow = Promise.withResolvers<{ terminals: [] }>()
    source.listTerminals.mockReturnValueOnce(slow.promise)
    forward({ ...base, workspaceId: 'repo::/c' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledTimes(3))
    forward({ ...base, workspaceId: 'repo::/d' })
    bridge.close('panel-b')
    slow.resolve({ terminals: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(panels[1]).toHaveBeenCalledTimes(2)
  })
})
