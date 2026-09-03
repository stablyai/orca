import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

function request(params: unknown): RpcRequest {
  return {
    id: 'request-1',
    authToken: 'token',
    method: 'session.tabs.createTerminal',
    params
  }
}

describe('session tab Web client context', () => {
  it('arms one-shot context for a legacy Agent without a startup prompt', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      decorateAgentEnvForClient: vi.fn((env: Record<string, string> | undefined) => env),
      armAgentClientContextForPty: vi.fn(),
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          ptyId: 'pty-1'
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      request({ worktree: 'id:wt-1', launchAgent: 'codex' }),
      () => {},
      {
        clientKind: 'runtime',
        pairedDeviceId: 'web-device',
        clientCapabilities: ['client-surface.web.v1']
      }
    )

    expect(runtime.armAgentClientContextForPty).toHaveBeenCalledWith('pty-1', 'web')
  })
})
