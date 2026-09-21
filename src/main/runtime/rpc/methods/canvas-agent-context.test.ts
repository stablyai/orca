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
import { CANVAS_CONTEXT_SYNC_METHOD } from './canvas-context-synchronization'
vi.mock('../../canvas/canvas-messaging-runtime', () => ({ refreshCanvasMessaging: vi.fn() }))

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
  it.each(['deferred', 'missing', 'changed-pty'] as const)(
    'applies pauses and disconnections without resetting C identity when C is %s',
    async (failure) => {
      const store = mocks.server.canvasContexts as CanvasAgentContextStore
      const identity = { sessionId: 'original', launchTokenHash: 'a'.repeat(64) }
      const bindings = ['a', 'b', 'c'].map((nodeId) => ({
        ...request.bindings[0],
        nodeId,
        paneKey: nodeId,
        peers: ['a', 'b', 'c'].filter((id) => id !== nodeId),
        collaborationPaused: false
      }))
      await store.replace(
        { ...request, bindings },
        new Map(bindings.map((binding) => [binding.nodeId, identity]))
      )
      const host = runtime()
      host.resolveTerminalPane.mockImplementation((...args: unknown[]) => {
        if (args[0] === 'c' && failure === 'missing') {
          throw new Error('Terminal unavailable')
        }
        return {
          handle: 'handle',
          executionHostId: 'local',
          ptyId: args[0] === 'c' && failure === 'changed-pty' ? 'replacement' : 'pty'
        }
      })
      const paused = bindings.map((binding) => ({ ...binding, collaborationPaused: true }))
      const deferredBindings = failure === 'deferred' ? [paused[2]] : []
      const result = await CANVAS_CONTEXT_SYNC_METHOD.handler(
        {
          ...request,
          revision: 2,
          bindings: failure === 'deferred' ? paused.slice(0, 2) : paused,
          deferredBindings
        },
        { runtime: host as unknown as OrcaRuntimeService }
      )
      expect(canvasContextReceiptSchema.parse(result).nodes.c.state).toBe('unverifiable')
      expect(
        store
          .snapshot()
          .get('canvas')
          ?.bindings.every((binding) => binding.collaborationPaused)
      ).toBe(true)
      const disconnected = paused.map((binding) => ({
        ...binding,
        peers: [],
        notes: [],
        collaborationPaused: false
      }))
      await CANVAS_CONTEXT_SYNC_METHOD.handler(
        {
          ...request,
          revision: 3,
          bindings: failure === 'deferred' ? disconnected.slice(0, 2) : disconnected,
          deferredBindings: failure === 'deferred' ? [disconnected[2]] : []
        },
        { runtime: host as unknown as OrcaRuntimeService }
      )
      const saved = store.snapshot().get('canvas')!.bindings
      expect(saved).toHaveLength(3)
      expect(
        saved.every((binding) => binding.peers?.length === 0 && binding.notes.length === 0)
      ).toBe(true)
      expect(saved.find((binding) => binding.nodeId === 'c')?.identity).toEqual(identity)
      const resumed = await store.replace(
        { ...request, revision: 4, bindings },
        new Map(
          bindings.map((binding) => [
            binding.nodeId,
            { sessionId: 'new', launchTokenHash: 'b'.repeat(64) }
          ])
        )
      )
      expect(resumed.nodes.c.state).toBe('session-changed')
    }
  )
  it('does not invent a binding for an unobserved node after reload', async () => {
    const result = await CANVAS_CONTEXT_SYNC_METHOD.handler(
      {
        ...request,
        deferredBindings: [{ nodeId: 'missing', notes: [], peers: [] }]
      },
      { runtime: runtime() as unknown as OrcaRuntimeService }
    )
    expect(canvasContextReceiptSchema.parse(result).nodes.missing).toBeUndefined()
    expect(canvasContextReceiptSchema.parse(result).nodes.agent).toBeDefined()
  })
  it('registers a recovered terminal on a same-revision refresh without another canvas edit', async () => {
    const host = runtime()
    host.resolveTerminalPane.mockImplementationOnce(() => {
      throw new Error('Unavailable')
    })
    const params = { ...request, deferredBindings: [] }
    const context = { runtime: host as unknown as OrcaRuntimeService }
    await CANVAS_CONTEXT_SYNC_METHOD.handler(params, context)
    const store = mocks.server.canvasContexts as CanvasAgentContextStore
    expect(store.snapshot().get('canvas')?.bindings).toEqual([])
    await CANVAS_CONTEXT_SYNC_METHOD.handler(params, context)
    expect(store.snapshot().get('canvas')?.bindings).toHaveLength(1)
  })
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
