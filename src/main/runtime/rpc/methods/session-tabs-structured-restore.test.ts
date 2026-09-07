import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab structured restore gating', () => {
  it('does not restore structured tabs for mobile while the host setting is off', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat: false })),
      restoreStructuredAgentSessionTabs: vi.fn(),
      listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot())
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
  })

  // Why: an old build has no capability to advertise, and skipping the restore left it with
  // nothing to project after a desktop restart — neither the chat nor its fallback row.
  it('restores structured tabs for a mobile client that advertises no capability', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat: true })),
      restoreStructuredAgentSessionTabs: vi.fn(),
      listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot())
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('restores structured tabs for mobile once the setting is present', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat: true })),
      restoreStructuredAgentSessionTabs: vi.fn(),
      listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot())
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })
})

function visibleSnapshot() {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal' as const,
    tabGroups: [{ id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] }],
    tabs: [
      {
        type: 'terminal' as const,
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: 'Terminal',
        status: 'ready' as const,
        terminal: 'pty-1',
        isActive: true
      }
    ]
  }
}
