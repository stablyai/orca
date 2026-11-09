import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import type { PluginRuntimeDelegate } from '../workers/plugin-host-service-bindings'
import { PluginPanelBridge } from './plugin-panel-bridge'

const caller = { id: 'panel-a', surface: 'panel' as const, contributionId: 'board' }
const LEAF = '11111111-1111-4111-8111-111111111111'

function setup(capabilities: PluginCapabilityKind[] = ['workspace:read']) {
  let active: string | null = 'repo::/w'
  const delegate: PluginRuntimeDelegate = {
    resolveActiveWorktreeContext: async () =>
      active
        ? { worktreeId: active, path: '/w', branch: 'refs/heads/main', displayName: 'w' }
        : null,
    listTerminals: async () => ({
      terminals: [{ handle: 'term_a', title: 'zsh', tabId: 'tab0', leafId: LEAF }]
    }),
    sendTerminal: vi.fn(),
    dispatchPluginNotification: vi.fn()
  }
  const bridge = new PluginPanelBridge({
    findApprovedPlugin: () => null,
    grantedCapabilities: () => capabilities,
    ensureWorker: vi.fn(),
    runningWorker: () => null,
    log: () => vi.fn(),
    runtimeDelegate: () => delegate
  })
  return { bridge, unfocus: () => (active = null) }
}

const context = { branch: 'main', displayName: 'w', terminals: [{ id: 'term_a', title: 'zsh' }] }

describe('workspace.changed replay on subscribe', () => {
  it('gives a panel the current context as soon as it subscribes', async () => {
    const { bridge } = setup()
    const deliver = vi.fn()
    bridge.open(caller, 'acme.board', deliver)
    bridge.subscribe('acme.board', caller.id, 'workspace.changed')
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith({
        kind: 'event',
        event: 'workspace.changed',
        payload: { context }
      })
    )
  })

  it('holds the replay until the channel opens, when the frame subscribed first', async () => {
    const { bridge, unfocus } = setup()
    unfocus()
    bridge.subscribe('acme.board', caller.id, 'workspace.changed')
    const deliver = vi.fn()
    bridge.open(caller, 'acme.board', deliver)
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith({
        kind: 'event',
        event: 'workspace.changed',
        payload: { context: null }
      })
    )
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('replays nothing for other events, or once the panel has closed', async () => {
    const { bridge } = setup(['workspace:read', 'agent:read'])
    const deliver = vi.fn()
    bridge.subscribe('acme.board', caller.id, 'workspace.changed')
    bridge.close(caller.id)
    bridge.open(caller, 'acme.board', deliver)
    bridge.subscribe('acme.board', caller.id, 'agent.status.changed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deliver).not.toHaveBeenCalled()
  })
})
