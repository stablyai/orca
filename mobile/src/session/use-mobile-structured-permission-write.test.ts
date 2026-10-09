import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-chat-permission-mode'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'host-1' } }
}

function options(mode: AgentChatPermissionMode): AgentSessionOptionsResult {
  return {
    models: [{ id: 'model-1', label: 'Model', isDefault: true, efforts: [] }],
    current: { model: 'model-1' },
    permissionModes: { current: mode, supported: ['ask', 'auto', 'bypass'] }
  }
}

function host() {
  let mode: AgentChatPermissionMode = 'bypass'
  let reads = 0
  let writes = 0
  let readRecovery: () => Promise<AgentSessionOptionsResult> = async () => options(mode)
  let write: (params: unknown) => Promise<RpcResponse> = async () => {
    throw markRpcDeliveryUnknown(new Error('Written request timed out'))
  }
  const client: RpcClient = {
    sendRequest: async (method, params) => {
      if (method === 'agentSession.options') {
        reads += 1
        return success(reads === 1 ? options(mode) : await readRecovery())
      }
      if (method === 'agentSession.setOption') {
        writes += 1
        return write(params)
      }
      return success({})
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
  return {
    client,
    reads: () => reads,
    writes: () => writes,
    mode: () => mode,
    setMode: (next: AgentChatPermissionMode) => {
      mode = next
    },
    onRead: (next: typeof readRecovery) => {
      readRecovery = next
    },
    onWrite: (next: typeof write) => {
      write = next
    },
    accept: (next: AgentChatPermissionMode) => {
      write = async () => {
        mode = next
        return success({ ok: true, value: { key: 'permissionMode', value: next } })
      }
    }
  }
}

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>

async function mount(agent: string, server: ReturnType<typeof host>) {
  const onSendError = vi.fn()
  const stateRef = { current: { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: 3 } }
  let rendered: Controller | null = null
  let renderer: ReactTestRenderer | null = null
  function Probe(props: { permissionMode?: string; fence: number }): null {
    const mutate = useMobileStructuredAgentMutate({
      client: server.client,
      sessionId: 'session-1',
      enabled: true,
      stateRef,
      onSendError
    })
    rendered = useMobileStructuredAgentOptions({
      agent,
      client: server.client,
      sessionId: 'session-1',
      enabled: true,
      fence: props.fence,
      permissionMode: props.permissionMode,
      mutate
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe, { fence: 3 }))
  })
  const current = (): Controller => {
    if (!rendered) {
      throw new Error('Probe did not render')
    }
    return rendered
  }
  return {
    current,
    onSendError,
    choose: async (mode: AgentChatPermissionMode) => {
      let result: boolean | undefined
      await act(async () => {
        result = await current().permissionPicker?.setMode(mode)
      })
      return result
    },
    rerender: async (permissionMode?: string, fence = 3) => {
      stateRef.current = { ...stateRef.current, fence }
      await act(async () => {
        renderer?.update(createElement(Probe, { fence, permissionMode }))
      })
    },
    unmount: async () => {
      await act(async () => renderer?.unmount())
    }
  }
}

describe.each(['claude', 'codex'])('%s unconfirmed permission write', (agent) => {
  it.each(['bypass', 'ask'] as const)(
    'reconciles host %s after a lost reply without claiming success',
    async (hostMode) => {
      const server = host()
      const read = deferred<AgentSessionOptionsResult>()
      server.onRead(() => read.promise)
      server.onWrite(async () => {
        server.setMode(hostMode)
        throw markRpcDeliveryUnknown(new Error('Written request timed out'))
      })
      const hook = await mount(agent, server)
      expect(hook.current().permissionPicker).toMatchObject({ provider: agent, current: 'bypass' })
      expect(await hook.choose('ask')).toBe(false)
      expect(hook.current().permissionPicker).toMatchObject({ current: 'bypass', pending: false })
      expect(hook.onSendError).toHaveBeenCalledExactlyOnceWith(
        "Orca couldn't confirm what happened. Check the chat."
      )
      expect(server.reads()).toBe(2)
      expect(server.writes()).toBe(1)
      await act(async () => {
        read.resolve(options(server.mode()))
      })
      expect(hook.current().permissionPicker?.current).toBe(hostMode)
      await hook.rerender()
      expect(server.reads()).toBe(2)
      await hook.unmount()
    }
  )

  it('allows another choice after recovery fails', async () => {
    const server = host()
    server.onRead(async () => {
      throw new Error('Read unavailable')
    })
    const hook = await mount(agent, server)
    expect(await hook.choose('ask')).toBe(false)
    expect(hook.current().permissionPicker).toMatchObject({ current: 'bypass', pending: false })
    server.accept('ask')
    expect(await hook.choose('ask')).toBe(true)
    expect(server.writes()).toBe(2)
    expect(hook.current().permissionPicker?.current).toBe('ask')
    await hook.unmount()
  })

  it('does not retire a delayed write when the recovery read still reports bypass', async () => {
    const server = host()
    const hook = await mount(agent, server)
    expect(await hook.choose('ask')).toBe(false)
    expect(hook.current().permissionPicker?.current).toBe('bypass')
    server.setMode('ask')
    await hook.rerender('ask')
    expect(hook.current().permissionPicker?.current).toBe('ask')
    expect(server.writes()).toBe(1)
    await hook.unmount()
  })

  it('allows a new choice while recovery is pending and discards the old read', async () => {
    const server = host()
    const read = deferred<AgentSessionOptionsResult>()
    server.onRead(() => read.promise)
    const hook = await mount(agent, server)
    expect(await hook.choose('ask')).toBe(false)
    server.accept('auto')
    server.onRead(async () => options(server.mode()))
    expect(await hook.choose('auto')).toBe(true)
    await act(async () => {
      read.resolve(options('ask'))
    })
    expect(hook.current().permissionPicker).toMatchObject({ current: 'auto', pending: false })
    expect(server.writes()).toBe(2)
    await hook.unmount()
  })

  it('discards a recovery read from the previous fence', async () => {
    const server = host()
    const read = deferred<AgentSessionOptionsResult>()
    server.onRead(() => read.promise)
    const hook = await mount(agent, server)
    expect(await hook.choose('ask')).toBe(false)
    server.onRead(async () => options('auto'))
    await hook.rerender(undefined, 4)
    await act(async () => {
      read.resolve(options('ask'))
    })
    expect(hook.current().permissionPicker?.current).toBe('auto')
    await hook.unmount()
  })

  it('also reconciles an unknown outcome reported by the host ledger', async () => {
    const server = host()
    server.onWrite(async () =>
      success({
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'diagnostic' }
      })
    )
    const hook = await mount(agent, server)
    expect(await hook.choose('ask')).toBe(false)
    expect(server.reads()).toBe(2)
    expect(hook.onSendError).toHaveBeenCalledExactlyOnceWith(
      "Orca couldn't confirm what happened. Check the chat."
    )
    expect(hook.current().permissionPicker?.current).toBe('bypass')
    await hook.unmount()
  })
})
