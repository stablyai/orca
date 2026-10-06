import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

// The host's own structured-chat setting is off throughout: it is a launch preference, so it must
// not decide whether chats a paired client opened come back after a restart.
function makeRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime members these RPCs read are staged.
  return {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat: false })),
    restoreStructuredAgentSessionTabs: vi.fn(),
    listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot())
  } as unknown as OrcaRuntimeService
}

async function listTabs(
  client?: Parameters<RpcDispatcher['dispatch']>[1]
): Promise<OrcaRuntimeService> {
  const runtime = makeRuntime()
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const response = await dispatcher.dispatch(
    makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
    client
  )
  expect(response.ok).toBe(true)
  return runtime
}

describe('structured session tab restoration', () => {
  it.each(['runtime', 'mobile'] as const)(
    'restores for a %s client that can read structured sessions',
    async (clientKind) => {
      const runtime = await listTabs({
        clientKind,
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      })

      expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
    }
  )

  it('restores for an in-process caller, which negotiates nothing', async () => {
    const runtime = await listTabs()

    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  // Why: an old build has no capability to advertise, and skipping the restore left it with
  // nothing to project after a desktop restart — neither the chat nor its fallback row.
  it('restores for a mobile client that advertises no capability', async () => {
    const runtime = await listTabs({ clientKind: 'mobile', clientCapabilities: [] })

    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('does not restore for a paired desktop that cannot read structured sessions', async () => {
    const runtime = await listTabs({ clientKind: 'runtime', clientCapabilities: [] })

    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
  })
})
