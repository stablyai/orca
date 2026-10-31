import * as selectionOperations from '../../../src/shared/structured-agent-session-selection-operations'
import {
  rememberMobileCreatedStructuredSession,
  mobileCreatedStructuredSession
} from './mobile-created-structured-sessions'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

function optionsFor(permissionMode?: string): AgentSessionOptionsResult {
  return {
    models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
    current: { model: 'gpt-live', ...(permissionMode ? { permissionMode } : {}) }
  }
}

function optionsClient(...modes: (string | undefined)[]) {
  let reads = 0
  const client: RpcClient = {
    sendRequest: async (method: string) => {
      if (method === 'agentSession.modelCatalog') {
        return {
          id: 'rpc-1',
          ok: false as const,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      const result =
        method === 'agentSession.options'
          ? optionsFor(modes[Math.min(reads++, modes.length - 1)])
          : {}
      return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, reads: () => reads }
}

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>
type ProbeProps = {
  client: RpcClient
  fence: number
  optionStamp: string
  agent?: string
  hostAdvertisesPermissionModes?: boolean | null
  permissionOwn?: boolean
}

const mutate: StructuredAgentSessionMutate = vi.fn()

async function mountOptions(props: ProbeProps) {
  const rendered: { current: Controller | null } = { current: null }
  function Probe(probe: ProbeProps): null {
    rendered.current = useMobileStructuredAgentOptions({
      agent: probe.agent ?? 'codex',
      client: probe.client,
      sessionId: 'session-1',
      enabled: true,
      fence: probe.fence,
      turnId: null,
      mutate,
      optionStamp: probe.optionStamp,
      hostSupport:
        probe.hostAdvertisesPermissionModes === null
          ? null
          : {
              sendOptions: false,
              permissionModes: probe.hostAdvertisesPermissionModes ?? true,
              permissionOwn: probe.permissionOwn,
              statusFeed: false
            }
    })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  const settle = () =>
    act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  await act(async () => {
    renderer = create(createElement(Probe, props))
  })
  await settle()
  return {
    pending: () => rendered.current?.pendingOptionId,
    images: () => rendered.current?.acceptsImages,
    offered: () => {
      const entry = rendered.current?.optionSnapshot.find(
        (descriptor) => descriptor.id === 'permissionMode'
      )
      return entry?.kind.type === 'select' ? entry.kind.choices.map((choice) => choice.value) : []
    },
    permission: () => {
      const entry = rendered.current?.optionSnapshot.find(
        (descriptor) => descriptor.id === 'permissionMode'
      )
      return entry?.kind.type === 'select' ? entry.kind.currentValue : null
    },
    rerender: async (next: Partial<ProbeProps>) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { ...props, ...next }))
      })
      await settle()
    },
    pick: async (mode: string, waitForResult = false) => {
      let result!: Promise<boolean>
      await act(async () => {
        result = rendered.current!.setStructuredOption('permissionMode', mode)
      })
      await settle()
      if (waitForResult) {
        return result
      }
    },
    unmount: () => act(async () => renderer?.unmount())
  }
}

// STA-10671: a 1.4.224 host ignores per-chat modes and runs its own Agent Permissions.
describe('the permission pill against a host predating per-chat modes', () => {
  it('publishes legacyHostPermissions only after a current options answer', async () => {
    const factory = vi.spyOn(selectionOperations, 'createStructuredSessionSelectionController')
    const old = Promise.withResolvers<AgentSessionOptionsResult>()
    const current = Promise.withResolvers<AgentSessionOptionsResult>()
    const rpc = optionsClient(undefined)
    const send = rpc.client.sendRequest
    let reads = 0
    rpc.client.sendRequest = async (method, params, config) =>
      method === 'agentSession.options'
        ? {
            id: 'held',
            ok: true,
            result: await (++reads === 1 ? old.promise : current.promise),
            _meta: { runtimeId: 'runtime-1' }
          }
        : send(method, params, config)
    rememberMobileCreatedStructuredSession('session-1', '/workspace')
    const options = await mountOptions({
      client: rpc.client,
      fence: 1,
      optionStamp: '',
      hostAdvertisesPermissionModes: false
    })
    const constructed = factory.mock.results.at(-1)
    if (constructed?.type !== 'return') {
      throw new Error('Phone selection owner was not created')
    }
    const controller = constructed.value
    await act(async () => {
      const pick = controller.issue('model', 'gpt-live', null)
      controller.settle(pick, { kind: 'unknown' })
    })
    await act(async () => old.resolve({ ...optionsFor(), acceptsImages: false }))
    expect(options.permission()).toBeNull()
    expect(options.images()).toBe(true)
    expect(mobileCreatedStructuredSession('session-1')).toEqual({ worktree: '/workspace' })
    await act(async () => current.resolve({ ...optionsFor(), acceptsImages: false }))
    expect(options.permission()).toBe('host')
    expect(options.offered()).toEqual(['host'])
    expect(options.images()).toBe(false)
    expect(mobileCreatedStructuredSession('session-1')).toBeUndefined()
    vi.mocked(mutate).mockClear()
    expect(await options.pick('own', true)).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    await options.unmount()
    factory.mockRestore()
  })

  // 1.4.225–1.4.226 apply modes without advertising the capability: their stated mode wins.
  it('shows the mode a host states even when it does not advertise per-chat modes', async () => {
    const options = await mountOptions({
      client: optionsClient('ask').client,
      fence: 1,
      optionStamp: 'gpt-live|ask',
      hostAdvertisesPermissionModes: false
    })
    expect(options.permission()).toBe('ask')
    await options.unmount()
  })

  it('shows no host pill before the host capability probe answers', async () => {
    const options = await mountOptions({
      client: optionsClient(undefined).client,
      fence: 1,
      optionStamp: 'gpt-live|',
      hostAdvertisesPermissionModes: null
    })
    expect(options.permission()).toBeNull()
    vi.mocked(mutate).mockClear()
    expect(await options.pick('own', true)).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    await options.unmount()
  })
})

describe('the permission mode on the phone', () => {
  it('writes only a concrete per-chat choice even when it matches the report for Own', async () => {
    vi.mocked(mutate).mockReset()
    vi.mocked(mutate).mockResolvedValue({
      status: 'accepted',
      value: { options: { permissionMode: 'full-access' } },
      sameFence: true
    })
    const client: RpcClient = {
      ...optionsClient().client,
      sendRequest: async () => ({
        id: 'rpc-1',
        ok: true,
        result: {
          ...optionsFor('own'),
          current: {
            model: 'gpt-live',
            permissionMode: 'own',
            reportedPermissionMode: 'full-access'
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    }
    const options = await mountOptions({ client, fence: 1, optionStamp: '', permissionOwn: true })
    expect(options.permission()).toBe('full-access')
    expect(options.offered()).not.toContain('own')
    await options.pick('full-access')
    expect(mutate).toHaveBeenCalledExactlyOnceWith(
      'agentSession.setOption',
      'agentSession.setOption',
      { key: 'permissionMode', value: 'full-access' }
    )
    await options.unmount()
    vi.mocked(mutate).mockReset()
  })

  it('re-reads once when the host status moves, so a desktop pick shows here', async () => {
    const rpc = optionsClient('ask', 'full-access')
    const options = await mountOptions({
      client: rpc.client,
      fence: 1,
      optionStamp: 'gpt-live|ask'
    })
    expect(options.permission()).toBe('ask')
    expect(rpc.reads()).toBe(1)

    await options.rerender({ optionStamp: 'gpt-live|full-access' })
    expect(options.permission()).toBe('full-access')
    expect(rpc.reads()).toBe(2)
    await options.unmount()
  })

  it('keeps the mode across a fence of the same chat', async () => {
    const rpc = optionsClient('auto')
    const options = await mountOptions({ client: rpc.client, fence: 1, optionStamp: '' })
    expect(options.permission()).toBe('auto')
    await options.rerender({ fence: 2 })
    expect(options.permission()).toBe('auto')
    await options.unmount()
  })

  it('shows a pick at once while its write waits behind a start, and stays pickable', async () => {
    const first =
      Promise.withResolvers<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    const second =
      Promise.withResolvers<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    vi.mocked(mutate)
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const rpc = optionsClient('ask')
    const options = await mountOptions({ client: rpc.client, fence: 1, optionStamp: '' })
    const send = rpc.client.sendRequest
    rpc.client.sendRequest = (method, params, config) =>
      method === 'agentSession.options' ? new Promise(() => {}) : send(method, params, config)
    await options.pick('full-access')
    expect(options.permission()).toBe('full-access')
    await options.pick('auto')
    expect(options.permission()).toBe('auto')
    expect(vi.mocked(mutate)).toHaveBeenCalledTimes(2)
    for (const [reply, value] of [
      [second, 'auto'],
      [first, 'full-access']
    ] as const) {
      await act(async () =>
        reply.resolve({
          status: 'accepted',
          value: { key: 'permissionMode', value, options: { permissionMode: value } },
          sameFence: true
        })
      )
      expect(options.pending()).toBeNull()
      expect(options.offered()).toContain('auto')
      expect(options.permission()).toBe('auto')
    }
    await options.unmount()
  })

  it('shows no pill for a host that states no mode', async () => {
    const rpc = optionsClient(undefined)
    const options = await mountOptions({ client: rpc.client, fence: 1, optionStamp: '' })
    expect(rpc.reads()).toBe(1)
    expect(options.permission()).toBeNull()
    await options.unmount()
  })
})

function listingLandsLaterClient() {
  let landed = false
  let land: () => void = () => {}
  const lands = new Promise<void>((resolve) => (land = resolve))
  const rows = [
    { id: 'opus[1m]', label: 'Opus', isDefault: true, efforts: [], supportsAutoMode: true },
    { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }
  ]
  const answer = async (method: string, waitForListing: boolean) => {
    if (method === 'agentSession.modelCatalog') {
      if (!waitForListing) {
        return { origin: 'unknown', listingInProgress: true }
      }
      await lands
      return { origin: 'probe', fetchedAt: 1, models: rows }
    }
    return landed
      ? { models: rows, current: { model: 'opus[1m]', permissionMode: 'ask' } }
      : {
          models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: [] }],
          current: { permissionMode: 'ask' }
        }
  }
  const client: RpcClient = {
    ...optionsClient().client,
    sendRequest: async (method: string, params?: unknown) => ({
      id: 'rpc-1',
      ok: true as const,
      result: await answer(
        method,
        typeof params === 'object' && params !== null && 'waitForListing' in params
      ),
      _meta: { runtimeId: 'runtime-1' }
    })
  }
  return {
    client,
    land: () => {
      landed = true
      land()
    }
  }
}

describe('Approve for me on a phone chat opened before its account was listed', () => {
  it('is offered before and after the listing lands', async () => {
    const host = listingLandsLaterClient()
    const options = await mountOptions({
      client: host.client,
      fence: 1,
      optionStamp: '',
      agent: 'claude'
    })
    expect(options.offered()).toEqual(['ask', 'accept-edits', 'auto', 'full-access'])
    host.land()
    await options.rerender({})
    expect(options.offered()).toEqual(['ask', 'accept-edits', 'auto', 'full-access'])
    await options.unmount()
  })
})
