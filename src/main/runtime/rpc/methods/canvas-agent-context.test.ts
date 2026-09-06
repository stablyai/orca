import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { CanvasAgentContextStore } from '../../../../shared/canvas-agent-context-store'
import {
  canvasContextReceiptSchema,
  type CanvasContextReplace
} from '../../../../shared/canvas-agent-context'

const mocks = vi.hoisted(() => ({
  server: { canvasContexts: undefined as unknown, getCurrentAuthorityObservations: vi.fn() }
}))
vi.mock('../../../agent-hooks/server', () => ({ agentHookServer: mocks.server }))
import { CANVAS_AGENT_CONTEXT_METHODS } from './canvas-agent-context'

const request: CanvasContextReplace = {
  canvasId: 'canvas',
  revision: 1,
  bindings: [
    {
      nodeId: 'agent',
      paneKey: 'pane',
      worktreeId: 'folder',
      ptyId: 'pty',
      provider: 'codex',
      notes: [{ id: 'note', title: 'Reference', content: 'Reference text' }]
    }
  ]
}
function runtime(host = 'local', enabled = true) {
  return {
    resolveTerminalPane: vi.fn(() => ({ handle: 'handle', ptyId: 'pty', executionHostId: host })),
    resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: 'pty' })),
    getOrchestrationDispatchAuthority: vi.fn(() => ({
      ptyId: 'pty',
      worktreeId: 'folder',
      launchTokenHash: 'a'.repeat(64)
    })),
    getClientSettings: vi.fn(() => ({ agentStatusHooksEnabled: enabled, disabledTuiAgents: [] }))
  }
}
beforeEach(() => {
  mocks.server.canvasContexts = new CanvasAgentContextStore()
  mocks.server.getCurrentAuthorityObservations.mockReturnValue([])
})
describe('canvas context execution boundary', () => {
  it('binds to the runtime-owned launch before its first hook', async () => {
    const host = runtime()
    const result = await CANVAS_AGENT_CONTEXT_METHODS[0].handler(request, {
      runtime: host as unknown as OrcaRuntimeService
    })
    expect(canvasContextReceiptSchema.parse(result).nodes.agent.state).toBe('waiting')
    expect(host.getOrchestrationDispatchAuthority).toHaveBeenCalledWith('handle')
  })
  it.each(['ssh:server', 'runtime:other'])(
    'does not store context locally for %s execution',
    async (hostId) => {
      const host = runtime(hostId)
      const result = await CANVAS_AGENT_CONTEXT_METHODS[0].handler(request, {
        runtime: host as unknown as OrcaRuntimeService
      })
      expect(canvasContextReceiptSchema.parse(result).nodes.agent.state).toBe('unsupported')
      expect(host.getOrchestrationDispatchAuthority).not.toHaveBeenCalled()
      expect(
        (mocks.server.canvasContexts as CanvasAgentContextStore).receipt('canvas', new Map()).nodes
      ).toEqual({})
    }
  )
  it('respects disabled hooks', async () => {
    const result = await CANVAS_AGENT_CONTEXT_METHODS[0].handler(request, {
      runtime: runtime('local', false) as unknown as OrcaRuntimeService
    })
    expect(canvasContextReceiptSchema.parse(result).nodes.agent.state).toBe('unsupported')
  })
  it('rejects a stale PTY before storing any notes', async () => {
    const host = runtime()
    host.resolveLiveLeafForHandle.mockReturnValue({ ptyId: 'replacement' })
    await expect(
      CANVAS_AGENT_CONTEXT_METHODS[0].handler(request, {
        runtime: host as unknown as OrcaRuntimeService
      })
    ).rejects.toThrow('session changed')
    expect(
      (mocks.server.canvasContexts as CanvasAgentContextStore).receipt('canvas', new Map()).nodes
    ).toEqual({})
  })
})
