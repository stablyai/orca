import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { RemoteDesktopTerminalFloor } from '../remote-desktop-terminal-floor'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'

async function startStream({
  multiplex,
  explicitClaims = true,
  restoreOwner = false
}: {
  multiplex: boolean
  explicitClaims?: boolean
  restoreOwner?: boolean
}) {
  const processWrites: string[] = []
  const messages: { type?: string; streamId?: number }[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const registry = createSubscriptionRegistryDouble()
  const applyLayout = vi.fn(async () => ({ ok: true }))
  const floor = new RemoteDesktopTerminalFloor({
    isMobileDriven: () => false,
    getTerminalSize: () => ({ cols: 120, rows: 40 }),
    resolveHostTarget: () => ({ cols: 120, rows: 40 }),
    hostShowsTerminals: () => false,
    applyLayout
  })
  if (restoreOwner) {
    await floor.updateViewer('pty-1', 'retired-stream', 'desktop-1', 120, 40, true)
    await floor.unregisterViewers('pty-1', ['retired-stream'])
    applyLayout.mockClear()
  }
  const runtime = stubRuntime({
    ...(restoreOwner ? { updateRemoteDesktopViewer: vi.fn(floor.updateViewer.bind(floor)) } : {}),
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'prompt', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    sendTerminal: vi.fn(async (handle: string, action: { text?: string }) => {
      processWrites.push(action.text ?? '')
      return { handle, accepted: true, bytesWritten: Buffer.byteLength(action.text ?? '') }
    })
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const controller = new AbortController()
  const subscribe = {
    terminal: 'terminal-1',
    client: { id: 'desktop-1', type: 'desktop' },
    ...(multiplex ? { inputSessionId: 'resize-input-session' } : {}),
    ...(restoreOwner ? {} : { viewport: { cols: 120, rows: 40 } }),
    capabilities: {
      terminalBinaryStream: 1,
      ...(multiplex ? { inputAck: 1 } : {}),
      ...(explicitClaims ? { desktopViewportClaims: 1 } : {})
    }
  }
  const done = dispatcher.dispatchStreaming(
    makeRequest(
      multiplex ? 'terminal.multiplex' : 'terminal.subscribe',
      multiplex ? {} : subscribe
    ),
    (message) => messages.push(JSON.parse(message).result ?? {}),
    {
      signal: controller.signal,
      connectionId: 'conn-resize-input',
      sendBinary: () => {},
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  if (multiplex) {
    await vi.waitFor(() => expect(handlers.has(0)).toBe(true))
    handlers.get(0)?.({
      opcode: TerminalStreamOpcode.Subscribe,
      streamId: 0,
      seq: 0,
      payload: encodeTerminalStreamJson({ ...subscribe, streamId: 7 })
    })
  }
  await vi.waitFor(() =>
    expect(messages.some((message) => message.type === 'subscribed')).toBe(true)
  )
  const streamId = messages.find((message) => message.type === 'subscribed')?.streamId
  if (typeof streamId !== 'number') {
    throw new Error('No subscribed stream id')
  }
  let inputSeq = 0
  const send = (opcode: TerminalStreamOpcode, payload: Uint8Array<ArrayBufferLike>): void => {
    const frame = decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode,
        streamId,
        seq: opcode === TerminalStreamOpcode.Input ? ++inputSeq : 0,
        payload
      })
    )
    if (!frame) {
      throw new Error('Invalid test frame')
    }
    handlers.get(streamId)?.(frame)
  }
  return {
    processWrites,
    updateViewport: vi.mocked(runtime.updateRemoteDesktopViewer),
    applyLayout,
    resize: () =>
      send(TerminalStreamOpcode.Resize, encodeTerminalStreamJson({ cols: 100, rows: 30 })),
    claim: () =>
      send(TerminalStreamOpcode.ClaimViewport, encodeTerminalStreamJson({ cols: 100, rows: 30 })),
    type: (text: string) => send(TerminalStreamOpcode.Input, encodeTerminalStreamText(text)),
    close: async () => {
      runtime.cleanupSubscription(
        multiplex ? 'terminal-multiplex:conn-resize-input' : 'terminal-1:desktop-1'
      )
      controller.abort()
      await done
    }
  }
}

describe.each([true, false])('remote input after passive resize (multiplex=%s)', (multiplex) => {
  it.each(['refused', 'thrown'])('preserves typing after a %s passive resize', async (failure) => {
    const stream = await startStream({ multiplex, restoreOwner: true })
    const layout = Promise.withResolvers<{ ok: boolean }>()
    try {
      stream.type('before')
      await vi.waitFor(() => expect(stream.processWrites).toEqual(['before']))
      stream.applyLayout.mockReturnValueOnce(layout.promise)
      stream.resize()
      await vi.waitFor(() => expect(stream.applyLayout).toHaveBeenCalledTimes(1))
      stream.type('during')
      stream.resize()
      stream.type('after')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stream.processWrites).toEqual(['before'])
      if (failure === 'thrown') {
        layout.reject(new Error('temporary geometry failure'))
      } else {
        layout.resolve({ ok: false })
      }
      await vi.waitFor(() => expect(stream.processWrites).toEqual(['before', 'during', 'after']))
      expect(stream.updateViewport).toHaveBeenLastCalledWith(
        'pty-1',
        expect.any(String),
        'desktop-1',
        100,
        30,
        false
      )

      expect(stream.applyLayout).toHaveBeenCalledTimes(1)
      stream.applyLayout.mockResolvedValueOnce({ ok: false })
      stream.claim()
      stream.resize()
      stream.type('blocked')
      stream.claim()
      stream.type('reclaimed')
      await vi.waitFor(() =>
        expect(stream.processWrites).toEqual(['before', 'during', 'after', 'reclaimed'])
      )
    } finally {
      layout.resolve({ ok: false })
      await stream.close()
    }
  })

  it('retains implicit-claim refusal and recovery for older clients', async () => {
    const stream = await startStream({ multiplex, explicitClaims: false })
    try {
      stream.updateViewport.mockResolvedValueOnce(false)
      stream.resize()
      stream.type('blocked')
      stream.resize()
      stream.type('retry')
      await vi.waitFor(() => expect(stream.processWrites).toEqual(['retry']))
      expect(stream.updateViewport).toHaveBeenLastCalledWith(
        'pty-1',
        expect.any(String),
        'desktop-1',
        100,
        30,
        true
      )
    } finally {
      await stream.close()
    }
  })
})
