import { describe, expect, it, vi, type Mock } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(experimentalStructuredNativeChat: boolean): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat })),
    restoreStructuredAgentSessionTabs: vi.fn(),
    listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot())
  } as unknown as OrcaRuntimeService
}

describe('structured session tab restoration follows one rule for every caller', () => {
  it('does not restore for the desktop renderer while the host setting is off', async () => {
    const runtime = makeRuntime(false)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'runtime',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
  })

  it('restores for the desktop renderer once the host setting is on', async () => {
    const runtime = makeRuntime(true)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'runtime',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('restores for an in-process caller on the same setting that admits remote clients', async () => {
    const restoreCallsBySetting = new Map<boolean, number>()
    for (const enabled of [false, true]) {
      const runtime = makeRuntime(enabled)
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      await dispatcher.dispatch(makeRequest('session.tabs.list', { worktree: 'id:wt-1' }))

      restoreCallsBySetting.set(
        enabled,
        (runtime.restoreStructuredAgentSessionTabs as unknown as Mock).mock.calls.length
      )
    }

    expect(restoreCallsBySetting.get(false)).toBe(0)
    expect(restoreCallsBySetting.get(true)).toBe(1)
  })
})

describe('session tab structured restore gating', () => {
  it('does not restore structured tabs for mobile while the host setting is off', async () => {
    const runtime = makeRuntime(false)
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
    const runtime = makeRuntime(true)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('restores structured tabs for mobile once the setting is present', async () => {
    const runtime = makeRuntime(true)
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
