import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcContext } from './rpc/core'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'
import { AGENT_SESSION_METHODS } from './rpc/methods/agent-session'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import { agentLaunchSurfaceFactory } from './rpc/methods/agent-launch-surfaces'
import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../shared/terminal-image-viewer-capability'

const viewers = [
  {
    label: 'old desktop',
    clientKind: 'runtime' as const,
    clientCapabilities: undefined,
    supported: false
  },
  {
    label: 'empty desktop',
    clientKind: 'runtime' as const,
    clientCapabilities: [],
    supported: false
  },
  {
    label: 'current desktop',
    clientKind: 'runtime' as const,
    clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY],
    supported: true
  },
  {
    label: 'mobile',
    clientKind: 'mobile' as const,
    clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY],
    supported: false
  }
]

function fixture() {
  const result = { handle: 'term_image', worktreeId: 'workspace', title: null }
  const runtime = {
    getRuntimeId: () => 'runtime',
    createTerminal: vi.fn().mockResolvedValue(result),
    dedupeTerminalCreate: async (
      _caller: string,
      _worktree: string | undefined,
      _mutation: string | undefined,
      _reconcile: boolean,
      run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
    ) => run('id:workspace', undefined),
    createAgentSession: vi.fn().mockResolvedValue({ terminal: result }),
    ensureAgentSession: vi.fn().mockResolvedValue({ terminal: result }),
    createMobileSessionTerminal: vi.fn().mockResolvedValue({ tab: { id: 'image-tab' } }),
    publishAgentLaunchTab: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each tested RPC only accesses the mocked methods; any unexpected runtime access fails immediately.
  const service = runtime as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({
    runtime: service,
    methods: [...TERMINAL_LIFECYCLE_METHODS, ...AGENT_SESSION_METHODS, ...SESSION_TAB_METHODS]
  })
  return { runtime, service, dispatcher }
}

for (const viewer of viewers) {
  describe(viewer.label, () => {
    it.each([
      'terminal.create',
      'terminal.createAgentSession',
      'terminal.ensureAgentSession',
      'session.tabs.createTerminal'
    ])('carries negotiated viewer policy through %s', async (method) => {
      const { runtime, dispatcher } = fixture()
      const params =
        method === 'terminal.create'
          ? { worktree: 'id:workspace', command: 'wrapped-claude', launchAgent: 'claude' }
          : method === 'terminal.ensureAgentSession'
            ? {
                kind: 'explicit',
                worktree: 'id:workspace',
                agent: 'claude',
                providerSession: { key: 'session_id', id: 'session' }
              }
            : method === 'terminal.createAgentSession'
              ? {
                  clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
                  worktree: 'id:workspace',
                  agent: 'claude'
                }
              : { worktree: 'id:workspace', agent: 'claude' }
      const result = await dispatcher.dispatch(
        { id: 'images', authToken: 'token', method, params },
        {
          pairedDeviceId: 'viewer',
          clientKind: viewer.clientKind,
          clientCapabilities: viewer.clientCapabilities
        }
      )
      expect(result.ok).toBe(true)
      const called =
        method === 'terminal.create'
          ? runtime.createTerminal
          : method === 'terminal.ensureAgentSession'
            ? runtime.ensureAgentSession
            : method === 'terminal.createAgentSession'
              ? runtime.createAgentSession
              : runtime.createMobileSessionTerminal
      expect(called.mock.calls[0]?.[1]).toMatchObject({
        terminalImageViewerSupported: viewer.supported
      })
    })
    it('carries the same policy through the agent.launch terminal factory', async () => {
      const { runtime, service } = fixture()
      const context: RpcContext = {
        runtime: service,
        caller: { kind: 'paired-device', deviceId: 'viewer' },
        pairedDeviceId: 'viewer',
        clientKind: viewer.clientKind,
        clientCapabilities: viewer.clientCapabilities
      }
      await agentLaunchSurfaceFactory(context).createTerminalAgent({
        worktreeId: 'workspace',
        agent: 'claude'
      })
      expect(runtime.createTerminal.mock.calls[0]?.[1]).toMatchObject({
        startupAgent: 'claude',
        terminalImageViewerSupported: viewer.supported
      })
    })
  })
}
