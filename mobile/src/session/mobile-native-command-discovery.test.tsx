import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'
import {
  commandDiscoveryRig,
  ompRecord
} from '../../../src/main/acp/acp-command-discovery.test-fixture'
import { useMobileNativeChatComposerMenu } from './native-chat/composer/use-mobile-native-chat-composer-menu'
import { deferred } from '../../../src/main/acp/acp-scripted-agent.test-support'

type Hook = ReturnType<typeof useMobileStructuredSessionCommands>

describe('mobile native command discovery', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  let menu: ReturnType<typeof useMobileNativeChatComposerMenu>
  const onChangeText = vi.fn()
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Probe(props: { client: RpcClient; sessionId: string }) {
    hook = useMobileStructuredSessionCommands({ ...props, hostId: 'host-1', enabled: true })
    menu = useMobileNativeChatComposerMenu({
      value: '/skill:pl',
      onChangeText,
      agent: 'omp',
      structuredCatalog: { reported: hook.commands, conversationCommands: [] },
      filePaths: [],
      focusField: vi.fn()
    })
    return null
  }

  it('receives real native rows on its first one-shot read and selects before any send, independently of slow teardown', async () => {
    const close = deferred<void>()
    const discovery = await commandDiscoveryRig((child) => {
      const prove = child.proveClose
      child.proveClose = async () => {
        await close.promise
        return prove()
      }
    })
    const sendRequest = vi.fn(async () => ({
      id: 'first-open',
      ok: true as const,
      result: { commands: await discovery.catalog.settled(ompRecord(), 10_000) },
      _meta: { runtimeId: 'host-runtime' }
    }))
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
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { client, sessionId: 'fresh-omp' }))
      })
      await act(async () => {
        await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce())
        await sendRequest.mock.results[0]!.value
      })
      await act(async () => menu.onSelectionChange({ start: 9, end: 9 }))
      const selected = menu.rows.find((row) => row.kind === 'skill')!
      expect(selected.kind).toBe('skill')
      if (selected.kind !== 'skill') {
        throw new Error('Missing native skill')
      }
      expect(selected.token).toBe('/skill:plan')
      expect(discovery.children[0]!.exited).toBe(false)
      await act(async () => menu.pick(selected))
      expect(`${onChangeText.mock.calls.at(-1)![0]}focus`).toBe('/skill:plan focus')
      expect(sendRequest).toHaveBeenCalledExactlyOnceWith('agentSession.commands', {
        sessionId: 'fresh-omp'
      })
      expect(discovery.children[0]!.agent.frames.map((frame) => frame.method)).toEqual([
        'initialize',
        'session/new'
      ])
    } finally {
      close.resolve()
      await discovery.dispose()
    }
  })
})
