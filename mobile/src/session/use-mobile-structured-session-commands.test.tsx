import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'

type Hook = ReturnType<typeof useMobileStructuredSessionCommands>

describe('useMobileStructuredSessionCommands', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Probe(props: { client: RpcClient; sessionId: string }) {
    hook = useMobileStructuredSessionCommands({ ...props, hostId: 'host-1', enabled: true })
    return null
  }

  it('reads the session’s list, again when the menu opens, and never shows another session’s', async () => {
    const lists: Record<string, { name: string; kind: 'skill' | 'command' }[]> = {
      a: [{ name: 'review-pr', kind: 'skill' }],
      b: [{ name: 'compact', kind: 'command' }]
    }
    const answers: { sessionId: string; answer: () => void }[] = []
    let holdNext = false
    const sendRequest = vi.fn(async (_method: string, params: unknown) => {
      const sessionId =
        typeof params === 'object' && params !== null && 'sessionId' in params
          ? String(params.sessionId)
          : ''
      if (holdNext) {
        holdNext = false
        await new Promise<void>((resolve) => answers.push({ sessionId, answer: resolve }))
      }
      return {
        id: 'rpc-1',
        ok: true as const,
        result: { commands: lists[sessionId] },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
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
    await act(async () => {
      renderer = create(createElement(Probe, { client, sessionId: 'a' }))
    })
    expect(sendRequest).toHaveBeenCalledWith('agentSession.commands', { sessionId: 'a' })
    expect(hook!.commands).toEqual(lists.a)

    lists.a = [...lists.a!, { name: 'research', kind: 'skill' }]
    await act(async () => hook!.refresh())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])

    holdNext = true
    await act(async () => renderer!.update(createElement(Probe, { client, sessionId: 'b' })))
    expect(hook!.commands).toBeUndefined()
    await act(async () => answers.shift()!.answer())
    expect(hook!.commands).toEqual(lists.b)
  })

  it('reads again after the current read when the menu opens during it', async () => {
    let catalog = [{ name: 'review-pr', kind: 'skill' as const }]
    const answers: (() => void)[] = []
    const sendRequest = vi.fn(async () => {
      const answered = [...catalog]
      await new Promise<void>((resolve) => answers.push(resolve))
      return {
        id: 'rpc-1',
        ok: true as const,
        result: { commands: answered },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
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
    await act(async () => {
      renderer = create(createElement(Probe, { client, sessionId: 'a' }))
    })
    // A skill lands on the host while the first read is still out, and the menu opens.
    catalog = [...catalog, { name: 'research', kind: 'skill' as const }]
    await act(async () => hook!.refresh())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => answers.shift()!())
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await act(async () => answers.shift()!())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])
  })
})
