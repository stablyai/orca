import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import {
  makeRequest,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

const QUERY_REPLY = '\x1b[0n'

describe('terminal query-reply opcode negotiation', () => {
  it.each([
    { negotiated: true, writes: 1 },
    { negotiated: false, writes: 0 }
  ])('accepts multiplex opcode 18 only when negotiated: $negotiated', async (testCase) => {
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal,
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true)
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    harness.handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'mobile-1', type: 'mobile' },
            capabilities: {
              ackOutput: 1,
              ...(testCase.negotiated ? { queryReply: 1 } : {})
            }
          })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        harness.messages.some(
          (message) =>
            JSON.parse(message).result?.type === 'subscribed' &&
            JSON.parse(message).result?.streamId === 7
        )
      ).toBe(true)
    )
    const subscribed = harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed' && event.streamId === 7)
    expect(subscribed?.capabilities?.queryReply).toBe(testCase.negotiated ? 1 : undefined)

    harness.handlers.get(7)?.(queryReplyFrame(7))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(testCase.writes))

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it.each([
    { negotiated: true, writes: 1 },
    { negotiated: false, writes: 0 }
  ])('accepts direct opcode 18 only when negotiated: $negotiated', async (testCase) => {
    const registry = createSubscriptionRegistryDouble()
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true),
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'mobile-1', type: 'mobile' },
        capabilities: {
          terminalBinaryStream: 1,
          ...(testCase.negotiated ? { queryReply: 1 } : {})
        }
      }),
      (message) => messages.push(message),
      {
        connectionId: `conn-direct-query-${testCase.negotiated}`,
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
        true
      )
    )
    const subscribed = messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed')
    expect(subscribed.capabilities?.queryReply).toBe(testCase.negotiated ? 1 : undefined)

    handlers.get(subscribed.streamId)?.(queryReplyFrame(subscribed.streamId))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(testCase.writes))

    runtime.cleanupSubscription('terminal-1:mobile-1')
    await dispatchPromise
  })
})

describe('terminal query-reply opcode guards', () => {
  const GUARD_CASES = [
    {
      name: 'a non-authority phone',
      authority: false,
      text: QUERY_REPLY,
      type: 'mobile' as const
    },
    {
      name: 'non-reply grammar',
      authority: true,
      text: ':q!\r',
      type: 'mobile' as const
    },
    {
      name: 'a desktop client',
      authority: true,
      text: QUERY_REPLY,
      type: 'desktop' as const
    }
  ]

  it.each(GUARD_CASES)('drops multiplex opcode 18 from $name', async (testCase) => {
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal,
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(testCase.authority)
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    harness.handlers.get(0)?.(
      subscribeFrame({
        streamId: 11,
        clientType: testCase.type,
        negotiated: true
      })
    )
    await vi.waitFor(() => expect(harness.handlers.has(11)).toBe(true))

    harness.handlers.get(11)?.(queryReplyFrame(11, testCase.text))
    // Ordinary input on the same stream proves the stream is live and the drop is guard-specific.
    harness.handlers.get(11)?.(inputFrame(11))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))
    expect(sendTerminal.mock.calls[0]?.[1]).toMatchObject({ text: ':q!\r' })

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it.each(GUARD_CASES)('drops direct opcode 18 from $name', async (testCase) => {
    const registry = createSubscriptionRegistryDouble()
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const runtime = stubRuntime({
      ...directSubscribeRuntime(registry),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(testCase.authority),
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'client-1', type: testCase.type },
        capabilities: { terminalBinaryStream: 1, queryReply: 1 }
      }),
      (message) => messages.push(message),
      {
        connectionId: `conn-guard-${testCase.name}`,
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
        true
      )
    )
    const streamId = messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed').streamId

    handlers.get(streamId)?.(queryReplyFrame(streamId, testCase.text))
    handlers.get(streamId)?.(inputFrame(streamId))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))
    expect(sendTerminal.mock.calls[0]?.[1]).toMatchObject({ text: ':q!\r' })

    runtime.cleanupSubscription('terminal-1:client-1')
    await dispatchPromise
  })
})

describe('terminal query-reply opcode 18 author identity', () => {
  // Why: the declared `client.id` is free-form page input; only the transport's device token is authenticated.
  const IDENTITY_CASES = [
    {
      name: 'a declared id impersonating another paired device',
      declaredClientId: 'mobile-authority',
      connectionClientId: 'mobile-impostor',
      delivered: false
    },
    {
      name: 'a declared id matching the connection device token',
      declaredClientId: 'mobile-authority',
      connectionClientId: 'mobile-authority',
      delivered: true
    },
    {
      name: 'a connection carrying no device token',
      declaredClientId: 'mobile-authority',
      connectionClientId: undefined,
      delivered: true
    }
  ]

  it.each(IDENTITY_CASES)('gates multiplex opcode 18 on $name', async (testCase) => {
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const harness = startDesktopMultiplexSubscribe(
      {
        sendTerminal,
        handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
        handleMobileUnsubscribe: vi.fn(),
        isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true)
      },
      undefined,
      undefined,
      testCase.connectionClientId
    )
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    harness.handlers.get(0)?.(
      subscribeFrame({
        streamId: 21,
        clientType: 'mobile',
        negotiated: true,
        clientId: testCase.declaredClientId
      })
    )
    await vi.waitFor(() => expect(harness.handlers.has(21)).toBe(true))

    harness.handlers.get(21)?.(queryReplyFrame(21))
    // Ordinary input on the same stream proves the stream is live and the drop is guard-specific.
    harness.handlers.get(21)?.(inputFrame(21))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(testCase.delivered ? 2 : 1))
    expect(sendTerminal.mock.calls.some((call) => call[1]?.text === QUERY_REPLY)).toBe(
      testCase.delivered
    )

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it.each(IDENTITY_CASES)('gates direct opcode 18 on $name', async (testCase) => {
    const registry = createSubscriptionRegistryDouble()
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const runtime = stubRuntime({
      ...directSubscribeRuntime(registry),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true),
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: testCase.declaredClientId, type: 'mobile' },
        capabilities: { terminalBinaryStream: 1, queryReply: 1 }
      }),
      (message) => messages.push(message),
      {
        connectionId: `conn-identity-${testCase.name}`,
        clientId: testCase.connectionClientId,
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
        true
      )
    )
    const streamId = messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed').streamId

    handlers.get(streamId)?.(queryReplyFrame(streamId))
    handlers.get(streamId)?.(inputFrame(streamId))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(testCase.delivered ? 2 : 1))
    expect(sendTerminal.mock.calls.some((call) => call[1]?.text === QUERY_REPLY)).toBe(
      testCase.delivered
    )

    runtime.cleanupSubscription(`terminal-1:${testCase.declaredClientId}`)
    await dispatchPromise
  })
})

function directSubscribeRuntime(registry: ReturnType<typeof createSubscriptionRegistryDouble>) {
  return {
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
    handleMobileUnsubscribe: vi.fn()
  }
}

function subscribeFrame(options: {
  streamId: number
  clientType: 'mobile' | 'desktop'
  negotiated: boolean
  clientId?: string
}) {
  return decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Subscribe,
      streamId: 0,
      seq: 1,
      payload: encodeTerminalStreamJson({
        streamId: options.streamId,
        terminal: 'terminal-1',
        client: { id: options.clientId ?? 'client-1', type: options.clientType },
        capabilities: {
          ackOutput: 1,
          ...(options.negotiated ? { queryReply: 1 } : {})
        }
      })
    })
  )!
}

function inputFrame(streamId: number) {
  return decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      streamId,
      seq: 3,
      payload: encodeTerminalStreamText(':q!\r')
    })
  )!
}

function queryReplyFrame(streamId: number, text: string = QUERY_REPLY) {
  return decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.QueryReply,
      streamId,
      seq: 2,
      payload: encodeTerminalStreamText(text)
    })
  )!
}
