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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the session-tab create surface this dispatch calls.
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

  it('decorates legacy agent creation only for a negotiated Web surface', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the decorate and create methods this Web-surface case calls.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      decorateAgentPromptForClient: vi.fn((prompt: string) => `[web/serve]\n${prompt}`),
      decorateAgentEnvForClient: vi.fn((env: Record<string, string> | undefined) => ({
        ...env,
        ORCA_CLIENT_SURFACE: 'web',
        ORCA_HOST_MODE: 'serve'
      })),
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: { type: 'terminal', id: 'tab-1::leaf-1' },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      request({
        worktree: 'id:wt-1',
        agent: 'codex',
        agentPrompt: 'Review this diff'
      }),
      () => {},
      {
        clientKind: 'runtime',
        pairedDeviceId: 'web-device',
        clientCapabilities: ['client-surface.web.v1']
      }
    )

    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        agentPrompt: '[web/serve]\nReview this diff',
        env: { ORCA_CLIENT_SURFACE: 'web', ORCA_HOST_MODE: 'serve' }
      })
    )
  })
})
