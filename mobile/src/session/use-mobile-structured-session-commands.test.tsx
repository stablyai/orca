import type { MobileCommandMenuHostFixtureModule } from '../../../src/shared/mobile-queued-edit-host.test-fixture-contract'
import type { AgentSessionCommandsResult } from '../../../src/shared/agent-session-wire'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import {
  mobileComposerCatalog,
  mobileComposerSkillTokens
} from './native-chat/composer/mobile-native-chat-composer-menu'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'

const { createMobileCommandMenuHostFixture } =
  await vi.importActual<MobileCommandMenuHostFixtureModule>(
    '../../../src/main/native-chat/agent-session-wire/mobile-queued-edit-host.test-fixture'
  )

type Hook = ReturnType<typeof useMobileStructuredSessionCommands>

describe('useMobileStructuredSessionCommands', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function Probe(props: {
    client: RpcClient
    sessionId: string
    commandsOnRequest?: boolean
    observe?: boolean
    enabled?: boolean
  }) {
    hook = useMobileStructuredSessionCommands({
      ...props,
      hostId: 'host-1',
      enabled: props.enabled ?? true
    })
    useMobileStructuredAgentState({
      client: props.client,
      sessionId: props.sessionId,
      sessionKey: props.sessionId,
      enabled: props.observe ?? false,
      connected: true,
      onCommandsChanged: hook.invalidate
    })
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
    catalog = [...catalog, { name: 'research', kind: 'skill' as const }]
    await act(async () => hook!.refresh())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => answers.shift()!())
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await act(async () => answers.shift()!())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])
  })
  it.each(['pending', 'lost-hint', 'lost-reply'])(
    'recovers a %s only while the same menu stays open',
    async (mode) => {
      vi.useFakeTimers()
      let first = true
      let finishFirstRead: () => void = () => {}
      const firstRead = new Promise<void>((resolve) => {
        finishFirstRead = resolve
      })
      const sendRequest = vi.fn(async () => {
        if (first) {
          first = false
          await firstRead
          if (mode === 'lost-reply') {
            throw new Error('transport timeout')
          }
          return {
            id: 'pending',
            ok: true as const,
            result: { commandsPending: true },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return {
          id: 'ready',
          ok: true as const,
          result: { commands: [{ name: 'fast', kind: 'command' }], commandsPending: false },
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
      try {
        await act(async () => {
          renderer = create(
            createElement(Probe, { client, sessionId: 'a', commandsOnRequest: true })
          )
        })
        expect(sendRequest).not.toHaveBeenCalled()
        await act(async () => hook!.setMenuOpen(true))
        if (mode !== 'lost-reply') {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000)
            finishFirstRead()
          })
          expect(sendRequest).toHaveBeenCalledTimes(1)
          // Probe completion at 12s wakes this demanded target, without a second probe.
          await act(async () => {
            vi.advanceTimersByTime(2_000)
            if (mode === 'pending') {
              hook!.invalidate()
            }
            await vi.advanceTimersByTimeAsync(mode === 'pending' ? 0 : 8_000)
          })
        } else {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000)
            finishFirstRead()
          })
          await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000)
          })
        }
        expect(hook!.commands?.map((row) => row.name)).toEqual(['fast'])
        expect(sendRequest).toHaveBeenCalledTimes(2)
        await act(async () => hook!.setMenuOpen(false))
        await act(async () => {
          hook!.invalidate()
          await vi.advanceTimersByTimeAsync(330_000)
        })
        expect(sendRequest).toHaveBeenCalledTimes(2)
      } finally {
        act(() => renderer?.unmount())
        renderer = null
        vi.useRealTimers()
      }
    }
  )
  it('keeps unknown, pending, defined and empty distinct through the real phone picker and live callback', async () => {
    vi.useFakeTimers()
    let response: AgentSessionCommandsResult = { commandsPending: true }
    let reject = false,
      held: Promise<void> | undefined
    let frame: (value: unknown) => void = () => {}
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'agentSession.commands') {
        const result = response
        if (held) {
          await held
        }
        if (reject) {
          throw new Error('transport unavailable')
        }
        return { id: 'commands', ok: true, result }
      }
      return { id: 'hold', ok: true, result: {} }
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: (_method, _params, onData) => {
        frame = onData
        return () => {}
      },
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    const tokens = () =>
      mobileComposerSkillTokens(
        mobileComposerCatalog({
          agent: 'claude',
          structured: { reported: hook!.commands, conversationCommands: [] },
          discovery: {
            status: 'ready',
            skills: [
              {
                id: 'review-pr',
                name: 'review-pr',
                description: null,
                providers: ['claude'],
                sourceKind: 'repo',
                sourceLabel: 'Repo',
                rootPath: '/skills',
                directoryPath: '/skills/review-pr',
                skillFilePath: '/skills/review-pr/SKILL.md',
                installed: true,
                updatedAt: null
              }
            ]
          }
        })
      )
    const event = (hint = false) =>
      frame({
        type: 'batch',
        sessionId: 'a',
        commands: null,
        ...(hint ? { commandsChanged: true } : {}),
        batch: {
          cursor: { epoch: 'e', sequence: 0 },
          items: [],
          removedItemIds: [],
          submissions: []
        }
      })
    await act(async () => {
      renderer = create(
        createElement(Probe, { client, sessionId: 'a', commandsOnRequest: true, observe: true })
      )
    })
    await act(async () => {
      event()
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => hook!.setMenuOpen(true))
    expect(hook!.commands).toBeUndefined()
    expect(tokens().has('/review-pr')).toBe(true)
    response = { commands: [{ name: 'review-pr', kind: 'skill' }], commandsPending: true }
    for (const hintAt of [0, 1, 2]) {
      await act(async () => {
        for (let index = 0; index < 3; index++) {
          event(index === hintAt)
        }
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(hook!.commands).toEqual(response.commands)
    }
    response = { commands: [], commandsPending: true }
    await act(async () => {
      event(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(tokens().has('/review-pr')).toBe(false)
    response = { commands: [{ name: 'fast', kind: 'command' }], commandsPending: false }
    await act(async () => {
      event(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(hook!.commands).toEqual(response.commands)
    response = { commandsPending: false }
    await act(async () => {
      event(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(hook!.commands).toBeUndefined()
    expect(tokens().has('/review-pr')).toBe(true)
    response = { commands: [], commandsPending: false }
    await act(async () => {
      event(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(tokens().has('/review-pr')).toBe(false)
    reject = true
    await act(async () => {
      event(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(hook!.commands).toEqual([])
    reject = false
    const late = Promise.withResolvers<void>()
    held = late.promise
    response = { commands: [{ name: 'obsolete', kind: 'skill' }], commandsPending: false }
    await act(async () => {
      event(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      hook!.setMenuOpen(false)
      renderer!.update(
        createElement(Probe, {
          client,
          sessionId: 'b',
          commandsOnRequest: true,
          observe: true,
          enabled: false
        })
      )
    })
    await act(async () => {
      late.resolve()
      await vi.advanceTimersByTimeAsync(600_000)
    })
    expect(hook!.commands).toBeUndefined()
    expect(tokens().has('/review-pr')).toBe(true)
  })

  it.each([
    ['claude', false],
    ['omp', false],
    ['claude', true]
  ] as const)(
    'recovers the parked %s phone menu (pending preparation=%s) through actual host retirement and dispatch',
    async (provider, pending) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const host = await createMobileCommandMenuHostFixture(provider, pending)
      let online = pending,
        stop = () => {}
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
        if (method !== 'agentSession.commands') {
          return { id: 'hold', ok: true, result: {} }
        }
        if (!online) {
          throw new Error('offline')
        }
        return { id: 'commands', ok: true, result: await host.read() }
      })
      const client: RpcClient = {
        sendRequest,
        subscribe: (_method, _params, onData) => {
          void host.subscribe(onData).then((value) => {
            stop = value
          })
          return () => stop()
        },
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
          renderer = create(
            createElement(Probe, {
              client,
              sessionId: host.sessionId,
              commandsOnRequest: true,
              observe: true
            })
          )
        })
        await act(async () => hook!.setMenuOpen(true))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(330_000)
        })
        const parked = sendRequest.mock.calls.filter(
          ([method]) => method === 'agentSession.commands'
        ).length
        if (pending) {
          expect(parked).toBeGreaterThan(3)
        } else {
          expect(parked).toBe(3)
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100_000)
        })
        expect(
          sendRequest.mock.calls.filter(([method]) => method === 'agentSession.commands')
        ).toHaveLength(parked)
        expect(host.starts()).toBe(0)
        online = true
        for (const scoped of [false, true]) {
          const starts = host.starts()
          await act(async () => {
            await host.retire(scoped)
            await vi.advanceTimersByTimeAsync(50)
          })
          await vi.waitFor(
            async () => {
              await act(async () => {
                await vi.advanceTimersByTimeAsync(50)
              })
              expect(hook!.commands?.some((row) => row.name === 'fast')).toBe(true)
              expect(host.starts()).toBe(starts + 1)
            },
            { interval: 0 }
          )
        }
        expect(host.starts()).toBe(2)
        await act(async () => hook!.setMenuOpen(false))
        const before = sendRequest.mock.calls.length
        await act(async () => {
          await host.retire(false)
          await vi.advanceTimersByTimeAsync(600_000)
        })
        expect(sendRequest).toHaveBeenCalledTimes(before)
      } finally {
        act(() => renderer?.unmount())
        renderer = null
        stop()
        await host.dispose()
        vi.useRealTimers()
      }
    }
  )
})
