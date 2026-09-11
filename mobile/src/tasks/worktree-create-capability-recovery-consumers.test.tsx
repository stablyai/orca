import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { resolveAvailableSmartModes } from './mobile-smart-source-modes'
import { useNewWorktreeRuntimeCapabilities } from './worktree-create-capability'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

// Why: the stable logical client keeps one RpcClient object across reconnects, so a
// status.get that failed mid-flight is the only probe the consumers ever see unless
// recovery re-runs it. These assert the consumer-visible fallout, not the probe count.

type CapabilityHook = ReturnType<typeof useNewWorktreeRuntimeCapabilities>

const SUPPORTED_STATUS: RpcResponse = {
  id: '1',
  ok: true,
  result: {
    capabilities: ['mobile.tasks.v1', 'worktree.create-idempotency.v1'],
    hostPlatform: 'darwin',
    worktreeCreateIdempotency: { dedupeTtlMs: 60_000 }
  },
  _meta: { runtimeId: 'runtime-1' }
}

class ReconnectingHostClient implements RpcClient {
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private state: ConnectionState = 'connected'
  private generation = 1
  private lastConnectedAt = 1
  readonly createParams: Record<string, unknown>[] = []
  readonly statusRequests = vi.fn<() => Promise<RpcResponse>>()
  createBehaviour: (attempt: number) => Promise<RpcResponse> = () =>
    Promise.resolve({
      id: 'c',
      ok: true,
      result: { worktree: { id: 'wt-1' } },
      _meta: { runtimeId: 'runtime-1' }
    })

  constructor(statusOutcomes: Array<RpcResponse | Error>) {
    let call = 0
    this.statusRequests.mockImplementation(async () => {
      const outcome = statusOutcomes[Math.min(call, statusOutcomes.length - 1)]!
      call += 1
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
    this.createParams.push((params ?? {}) as Record<string, unknown>)
    return this.createBehaviour(this.createParams.length)
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
    return this.lastConnectedAt
  }
  getLastInboundAt(): number | null {
    return null
  }
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notifyForeground(): void {}
  close(): void {}

  getGeneration = (): number => this.generation

  emitState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }

  migrateTransport(): void {
    this.generation += 1
    this.emitState(this.state)
  }

  // Why: a relay lease rotation re-dials the same runtime, so runtimeId is unchanged.
  reconnectSameRuntime(): void {
    this.lastConnectedAt += 1
    this.emitState('connected')
  }
}

async function mountCapabilities(client: RpcClient): Promise<{
  readonly current: CapabilityHook
  switchHost(next: RpcClient): Promise<void>
  unmount(): void
}> {
  let current: CapabilityHook | null = null
  let renderer: ReactTestRenderer | null = null
  function Probe({ host }: { host: RpcClient }): null {
    current = useNewWorktreeRuntimeCapabilities(host, true)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe, { host: client }))
    await Promise.resolve()
  })
  return {
    get current(): CapabilityHook {
      if (!current) {
        throw new Error('capability probe did not render')
      }
      return current
    },
    switchHost: async (next) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { host: next }))
        await Promise.resolve()
      })
    },
    unmount: () => act(() => renderer?.unmount())
  }
}

function taskModes(capabilities: CapabilityHook): string[] {
  return resolveAvailableSmartModes({
    textOnly: false,
    tasksSupported: capabilities.tasksSupported,
    hasRepo: true,
    githubAvailable: false,
    gitlabAvailable: false,
    linearAvailable: false
  })
}

async function reconnect(client: ReconnectingHostClient): Promise<void> {
  await act(async () => {
    client.emitState('reconnecting')
    client.emitState('connected')
    await Promise.resolve()
  })
}

describe('new-workspace consumers after a mid-flight status.get failure', () => {
  it('restores the task-backed composer tabs once the host answers again', async () => {
    const client = new ReconnectingHostClient([
      markRpcDeliveryUnknown(new Error('socket closed mid-request')),
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(client)

    await reconnect(client)

    expect(
      resolveAvailableSmartModes({
        textOnly: false,
        tasksSupported: capabilities.current.tasksSupported,
        hasRepo: true,
        githubAvailable: true,
        gitlabAvailable: true,
        linearAvailable: true
      })
    ).toEqual(['smart', 'github', 'linear', 'gitlab', 'branches', 'text'])
    expect(capabilities.current.hostPlatform).toBe('darwin')
    capabilities.unmount()
  })

  it('stamps worktree.create with the idempotency key the host advertised', async () => {
    const client = new ReconnectingHostClient([
      markRpcDeliveryUnknown(new Error('socket closed mid-request')),
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(client)

    await reconnect(client)
    await act(async () => {
      await createWorktreeWithNameRetry({
        client,
        baseName: 'otter',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: capabilities.current.getWorktreeCreateCutoverSupport(),
        mintMutationId: () => 'mutation-1'
      })
    })

    expect(client.createParams).toEqual([
      { repo: 'id:r', name: 'otter', clientMutationId: 'mutation-1' }
    ])
    capabilities.unmount()
  })

  it('replays a delivery-ambiguous create instead of surfacing it as a failure', async () => {
    const client = new ReconnectingHostClient([
      markRpcDeliveryUnknown(new Error('socket closed mid-request')),
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(client)
    await reconnect(client)

    client.createBehaviour = (attempt) => {
      if (attempt === 1) {
        client.emitState('disconnected')
        setTimeout(() => client.emitState('connected'), 0)
        return Promise.reject(markRpcDeliveryUnknown(new Error('relay session not connected')))
      }
      return Promise.resolve({
        id: 'c',
        ok: true,
        result: { worktree: { id: 'wt-1' } },
        _meta: { runtimeId: 'runtime-1' }
      })
    }

    let result: Awaited<ReturnType<typeof createWorktreeWithNameRetry>> | null = null
    await act(async () => {
      result = await createWorktreeWithNameRetry({
        client,
        baseName: 'otter',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: capabilities.current.getWorktreeCreateCutoverSupport(),
        mintMutationId: () => 'mutation-1'
      })
    })

    expect(result).toEqual({ worktreeId: 'wt-1', name: 'otter' })
    expect(client.createParams.map((params) => params.clientMutationId)).toEqual([
      'mutation-1',
      'mutation-1'
    ])
    capabilities.unmount()
  })
  it('recovers when the host answered status.get with a transient server error', async () => {
    const client = new ReconnectingHostClient([
      {
        id: '1',
        ok: false,
        error: { code: 'internal_error', message: 'busy' },
        _meta: { runtimeId: 'runtime-1' }
      },
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(client)

    await reconnect(client)
    await act(async () => {
      await createWorktreeWithNameRetry({
        client,
        baseName: 'otter',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: capabilities.current.getWorktreeCreateCutoverSupport(),
        mintMutationId: () => 'mutation-1'
      })
    })

    expect({
      modes: resolveAvailableSmartModes({
        textOnly: false,
        tasksSupported: capabilities.current.tasksSupported,
        hasRepo: true,
        githubAvailable: false,
        gitlabAvailable: false,
        linearAvailable: false
      }),
      createParams: client.createParams
    }).toEqual({
      modes: ['smart', 'branches', 'text'],
      createParams: [{ repo: 'id:r', name: 'otter', clientMutationId: 'mutation-1' }]
    })
    capabilities.unmount()
  })
  it('re-reads capabilities after a transport migration retires the old runtime', async () => {
    // A migration lands on a different host runtime, so an authoritative
    // "unsupported" from the retired one must not outlive it.
    const client = new ReconnectingHostClient([
      {
        id: '1',
        ok: false,
        error: { code: 'method_not_found', message: 'gone' },
        _meta: { runtimeId: 'runtime-0' }
      },
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.migrateTransport()
      await Promise.resolve()
    })

    expect(taskModes(capabilities.current)).toEqual(['smart', 'branches', 'text'])
    capabilities.unmount()
  })

  it('lets a later grant overturn an authoritative refusal from the same runtime', async () => {
    // A permission-gated `forbidden` is authoritative about that moment, not about the
    // runtime forever: the same runtimeId can start answering once the grant lands.
    const client = new ReconnectingHostClient([
      {
        id: '1',
        ok: false,
        error: { code: 'forbidden', message: 'not granted' },
        _meta: { runtimeId: 'runtime-1' }
      },
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.reconnectSameRuntime()
      await Promise.resolve()
    })
    await act(async () => {
      await createWorktreeWithNameRetry({
        client,
        baseName: 'otter',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: capabilities.current.getWorktreeCreateCutoverSupport(),
        mintMutationId: () => 'mutation-1'
      })
    })

    expect({
      modes: taskModes(capabilities.current),
      hostPlatform: capabilities.current.hostPlatform,
      createParams: client.createParams
    }).toEqual({
      modes: ['smart', 'branches', 'text'],
      hostPlatform: 'darwin',
      createParams: [{ repo: 'id:r', name: 'otter', clientMutationId: 'mutation-1' }]
    })
    capabilities.unmount()
  })

  it('retries a status.get that timed out without the connection ever changing', async () => {
    vi.useFakeTimers()
    try {
      const client = new ReconnectingHostClient([
        new Error('status.get timed out'),
        SUPPORTED_STATUS
      ])
      const capabilities = await mountCapabilities(client)

      // No reconnect, no migration, no modal re-open: the socket never left 'connected'.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      await act(async () => {
        await createWorktreeWithNameRetry({
          client,
          baseName: 'otter',
          buildParams: (name) => ({ repo: 'id:r', name }),
          worktreeCreateIdempotency: capabilities.current.getWorktreeCreateCutoverSupport(),
          mintMutationId: () => 'mutation-1'
        })
      })

      expect({
        modes: taskModes(capabilities.current),
        hostPlatform: capabilities.current.hostPlatform,
        createParams: client.createParams
      }).toEqual({
        modes: ['smart', 'branches', 'text'],
        hostPlatform: 'darwin',
        createParams: [{ repo: 'id:r', name: 'otter', clientMutationId: 'mutation-1' }]
      })
      capabilities.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps recovering after the user switches to a different host', async () => {
    const first = new ReconnectingHostClient([SUPPORTED_STATUS])
    const second = new ReconnectingHostClient([
      markRpcDeliveryUnknown(new Error('socket closed mid-request')),
      SUPPORTED_STATUS
    ])
    const capabilities = await mountCapabilities(first)

    await capabilities.switchHost(second)
    await reconnect(second)

    expect(taskModes(capabilities.current)).toEqual(['smart', 'branches', 'text'])
    capabilities.unmount()
  })
})
