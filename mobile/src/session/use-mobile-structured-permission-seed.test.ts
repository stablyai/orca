import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AgentSessionPermissionSeed } from '../../../src/shared/agent-chat-permission-mode'
import type { RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))

function success(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'host' } }
}

it.each(['claude', 'codex'])(
  'offers all %s permission modes on the first frame and accepts Auto before attachment',
  async (agent) => {
    const seed: AgentSessionPermissionSeed = { mode: 'ask', fence: 7 }
    const replies: ((value: RpcResponse) => void)[] = []
    const sendRequest = vi.fn(async (method: string) =>
      method === 'agentSession.options'
        ? new Promise<RpcResponse>((resolve) => replies.push(resolve))
        : success({
            ok: true,
            value: { key: 'permissionMode', value: 'auto', options: { permissionMode: 'auto' } }
          })
    )
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    const stateRef = { current: { ...EMPTY_STRUCTURED_AGENT_SESSION } }
    let hook: ReturnType<typeof useMobileStructuredAgentOptions> | null = null
    let renderer: ReactTestRenderer | null = null
    const read = (): ReturnType<typeof useMobileStructuredAgentOptions> => {
      if (!hook) {
        throw new Error('No hook')
      }
      return hook
    }
    function Probe(props: { permissionMode?: string; seed?: AgentSessionPermissionSeed }): null {
      const mutate = useMobileStructuredAgentMutate({
        client,
        sessionId: 'chat',
        enabled: true,
        stateRef,
        permissionSeed: props.seed,
        onSendError: () => {}
      })
      hook = useMobileStructuredAgentOptions({
        agent,
        client,
        sessionId: 'chat',
        enabled: true,
        fence: null,
        permissionSeed: props.seed,
        permissionMode: props.permissionMode,
        mutate
      })
      return null
    }
    const report = (current: string, supported: readonly string[]) =>
      success({
        models: [{ id: 'm', label: 'M', isDefault: true, efforts: [] }],
        current: { model: 'm' },
        permissionModes: { current, supported }
      })
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { seed }))
      })
      expect(read().permissionPicker).toMatchObject({ current: 'ask', pending: false })
      expect(read().permissionPicker?.supported).toEqual(
        agent === 'claude' ? ['ask', 'accept-edits', 'auto', 'bypass'] : ['ask', 'auto', 'bypass']
      )
      await act(async () => {
        expect(await read().permissionPicker?.setMode('auto')).toBe(true)
      })
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.setOption',
        expect.objectContaining({
          key: 'permissionMode',
          value: 'auto',
          envelope: expect.objectContaining({ expectedRuntimeFence: 7 })
        }),
        expect.anything()
      )
      expect(read().permissionPicker?.current).toBe('auto')
      // Startup publishes the narrower host intent while the original model/options read is held.
      await act(async () => {
        renderer?.update(createElement(Probe, { seed, permissionMode: 'ask' }))
      })
      const supported = agent === 'claude' ? ['ask', 'accept-edits', 'bypass'] : ['ask', 'bypass']
      await act(async () => {
        replies.at(-1)?.(report('ask', supported))
      })
      expect(read().permissionPicker).toMatchObject({ current: 'ask', supported })
      await act(async () => {
        replies[0]?.(report('auto', [...supported, 'auto']))
      })
      expect(read().permissionPicker?.current).toBe('ask')
    } finally {
      await act(async () => {
        renderer?.unmount()
      })
    }
  }
)

it('does not infer picker support from an older host', async () => {
  let renderer: ReactTestRenderer | null = null
  let picker: unknown
  function Probe(): null {
    picker = useMobileStructuredAgentOptions({
      agent: 'codex',
      client: null,
      sessionId: 'chat',
      enabled: true,
      fence: null,
      mutate: async () => ({ status: 'rejected' })
    }).permissionPicker
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  expect(picker).toBeNull()
  await act(async () => {
    renderer?.unmount()
  })
})
