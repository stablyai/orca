import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { useNewWorktreeRuntimeCapabilities } from './worktree-create-capability'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

type CapabilityHook = ReturnType<typeof useNewWorktreeRuntimeCapabilities>

class CapabilityClient implements RpcClient {
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private state: ConnectionState = 'connected'
  private generation = 1
  private connectedAt = 1
  readonly statusRequests = vi.fn<() => Promise<RpcResponse>>()
  readonly createRequests: Record<string, unknown>[] = []

  constructor(statusOutcomes: Array<RpcResponse | Error>) {
    let statusCall = 0
    this.statusRequests.mockImplementation(async () => {
      const outcome = statusOutcomes[Math.min(statusCall, statusOutcomes.length - 1)]!
      statusCall += 1
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    })
  }

  async sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
    if (method === 'status.get') {
      return this.statusRequests()
    }
    this.createRequests.push((params ?? {}) as Record<string, unknown>)
    return success({ worktree: { id: 'wt-1' } })
  }

  subscribe(): () => void {
    return () => {}
  }

  updateTerminalSubscriptionViewport(): void {}
  getState(): ConnectionState {
    return this.state
  }
  getReconnectAttempt(): number {
    return 0
  }
  getLastConnectedAt(): number | null {
    return this.connectedAt
  }
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notifyForeground(): void {}
  close(): void {}

  emitState(state: ConnectionState): void {
    this.state = state
    this.emitCurrentState()
  }

  bumpGeneration(): void {
    this.generation += 1
    this.emitCurrentState()
  }

  bumpConnectedAt(): void {
    this.connectedAt += 1
    this.emitCurrentState()
  }

  getGeneration = (): number => this.generation

  private emitCurrentState(): void {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}

function success(result: unknown, runtimeId = 'r'): RpcResponse {
  return { id: '1', ok: true, result, _meta: { runtimeId } }
}

function failure(code: string, runtimeId = 'r'): RpcResponse {
  return {
    id: '1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId }
  }
}

function supported(runtimeId = 'r'): RpcResponse {
  return success(
    {
      capabilities: ['mobile.tasks.v1', 'worktree.create-idempotency.v1'],
      hostPlatform: 'darwin'
    },
    runtimeId
  )
}

async function mountCapabilities(client: RpcClient): Promise<{
  readonly current: CapabilityHook
  setEnabled(enabled: boolean): Promise<void>
  unmount(): void
}> {
  let current: CapabilityHook | null = null
  let renderer: ReactTestRenderer | null = null
  function Probe({ enabled }: { enabled: boolean }): null {
    current = useNewWorktreeRuntimeCapabilities(client, enabled)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe, { enabled: true }))
    await Promise.resolve()
  })
  return {
    get current(): CapabilityHook {
      if (!current) {
        throw new Error('capability probe did not render')
      }
      return current
    },
    setEnabled: async (enabled) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { enabled }))
        await Promise.resolve()
      })
    },
    unmount: () => act(() => renderer?.unmount())
  }
}

describe('useNewWorktreeRuntimeCapabilities reconnect recovery', () => {
  it('recovers a transient probe and enables idempotent create after reconnect', async () => {
    const client = new CapabilityClient([new Error('offline'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('connected')
      await Promise.resolve()
    })
    await createWorktreeWithNameRetry({
      client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: capabilities.current.getWorktreeCreateCutoverSupport(),
      mintMutationId: () => 'mutation-after-reconnect'
    })

    expect({
      statusRequests: client.statusRequests.mock.calls.length,
      tasksSupported: capabilities.current.tasksSupported,
      clientMutationId: client.createRequests[0]?.clientMutationId
    }).toEqual({
      statusRequests: 2,
      tasksSupported: true,
      clientMutationId: 'mutation-after-reconnect'
    })
    capabilities.unmount()
  })

  it('keeps an authoritative unsupported response cached across reconnect', async () => {
    const client = new CapabilityClient([failure('method_not_found'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('connected')
      await Promise.resolve()
    })

    expect(client.statusRequests).toHaveBeenCalledOnce()
    expect(capabilities.current.tasksSupported).toBe(false)
    capabilities.unmount()
  })

  it.each(['forbidden', 'invalid_argument'])(
    'keeps an authoritative %s response cached across reconnect',
    async (code) => {
      const client = new CapabilityClient([failure(code), supported()])
      const capabilities = await mountCapabilities(client)

      await act(async () => {
        client.emitState('reconnecting')
        client.emitState('connected')
        await Promise.resolve()
      })

      expect(client.statusRequests).toHaveBeenCalledOnce()
      expect(capabilities.current.tasksSupported).toBe(false)
      capabilities.unmount()
    }
  )

  it('re-probes an internal error response after reconnect', async () => {
    const client = new CapabilityClient([failure('internal_error'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('connected')
      await Promise.resolve()
    })

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })

  it('re-probes a transient result when the capability consumer is reopened', async () => {
    const client = new CapabilityClient([new Error('timeout'), supported()])
    const capabilities = await mountCapabilities(client)

    await capabilities.setEnabled(false)
    await capabilities.setEnabled(true)

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })

  it('invalidates an authoritative result when the runtime identity changes', async () => {
    const client = new CapabilityClient([
      failure('method_not_found', 'runtime-1'),
      supported('runtime-2')
    ])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.bumpConnectedAt()
      await Promise.resolve()
    })

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })

  it('re-probes a transient result when the logical client generation changes', async () => {
    const client = new CapabilityClient([new Error('timeout'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.bumpGeneration()
      await Promise.resolve()
    })

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })

  it('re-probes a transient result when connectedAt changes', async () => {
    const client = new CapabilityClient([new Error('timeout'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.bumpConnectedAt()
      await Promise.resolve()
    })

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })

  it('starts at most one replacement probe for a flapping reconnect', async () => {
    const client = new CapabilityClient([new Error('offline'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('disconnected')
      client.emitState('reconnecting')
      client.emitState('connected')
      client.emitState('connected')
      await Promise.all([
        capabilities.current.getWorktreeCreateCutoverSupport(),
        capabilities.current.getWorktreeCreateCutoverSupport()
      ])
    })

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })
})
