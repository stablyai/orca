import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from './runtime-client'
import type { RuntimeRpcSuccess } from './runtime/types'
import { runTerminalBridge } from './terminal-bridge'

type StreamEvent = Record<string, unknown> & { type?: unknown }

class GatedWritable extends Writable {
  readonly writes: string[] = []
  readonly releases: (() => void)[] = []

  constructor() {
    super({ highWaterMark: 1 })
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.writes.push(chunk.toString())
    this.releases.push(callback)
  }
}

describe('terminal bridge', () => {
  it('forwards stream events and sends raw input through the same client', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let emit = (_event: RuntimeRpcSuccess<StreamEvent>): void => {}
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const close = vi.fn(resolveDone)
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 5 } }
    })
    let subscriptionClientId = ''
    const client = {
      streamLocal: vi.fn((_method, params, onEvent) => {
        subscriptionClientId = params.client.id
        emit = onEvent
        return { done, close }
      }),
      call
    } as unknown as RuntimeClient
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(String(chunk)))

    const bridge = runTerminalBridge({
      client,
      terminal: 'term-1',
      input,
      output
    })
    emit(success({ type: 'scrollback', serialized: 'ready' }))
    input.write(`${JSON.stringify({ type: 'input', data: '\u0003raw\r' })}\n`)
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    emit(success({ type: 'data', chunk: '\u0003raw\r' }))
    input.write('{"type":"close"}\n')
    await bridge

    expect(subscriptionClientId).toMatch(/^orca-cli-bridge-/)
    expect(call).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: '\u0003raw\r',
      enter: false,
      interrupt: false,
      client: { id: subscriptionClientId, type: 'desktop' }
    })
    expect(chunks.join('')).toBe(
      `${JSON.stringify({ type: 'scrollback', serialized: 'ready' })}\n${JSON.stringify({ type: 'data', chunk: '\u0003raw\r' })}\n`
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('claims a bounded viewport through the subscribed client identity', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let subscriptionClientId = ''
    const close = vi.fn(resolveDone)
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: { updated: true, applied: true }
    })
    const streamLocal = vi.fn((_method, params) => {
      subscriptionClientId = params.client.id
      return { done, close }
    })
    const client = { streamLocal, call } as unknown as RuntimeClient

    const bridge = runTerminalBridge({ client, terminal: 'term-1', input, output })
    input.write(`${JSON.stringify({ type: 'resize', cols: 132, rows: 44 })}\n`)
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    input.write('{"type":"close"}\n')
    await bridge

    expect(streamLocal).toHaveBeenCalledWith(
      'terminal.subscribe',
      {
        terminal: 'term-1',
        client: { id: subscriptionClientId, type: 'desktop' },
        viewport: { cols: 80, rows: 24 },
        capabilities: { desktopViewportClaims: 1 }
      },
      expect.any(Function)
    )
    expect(call).toHaveBeenCalledWith('terminal.updateViewport', {
      terminal: 'term-1',
      client: { id: subscriptionClientId, type: 'desktop' },
      viewport: { cols: 132, rows: 44 },
      claim: true
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rejects non-integer and out-of-range viewport dimensions without calling the runtime', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const call = vi.fn()
    const client = {
      streamLocal: vi.fn(() => ({ done, close: resolveDone })),
      call
    } as unknown as RuntimeClient
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(String(chunk)))

    const bridge = runTerminalBridge({ client, terminal: 'term-1', input, output })
    const invalidFrames = [
      { type: 'resize', cols: 19, rows: 24 },
      { type: 'resize', cols: 241, rows: 24 },
      { type: 'resize', cols: 80, rows: 7 },
      { type: 'resize', cols: 80, rows: 121 },
      { type: 'resize', cols: 80.5, rows: 24 },
      { type: 'resize', cols: '80', rows: 24 }
    ]
    input.write(`${invalidFrames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
    await vi.waitFor(() => expect(chunks).toHaveLength(invalidFrames.length))
    input.write('{"type":"close"}\n')
    await bridge

    expect(call).not.toHaveBeenCalled()
    expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual(
      invalidFrames.map(() => ({
        type: 'error',
        error: {
          code: 'invalid_argument',
          message: 'Terminal bridge resize requires integer cols 20-240 and rows 8-120.'
        }
      }))
    )
  })

  it('preserves stdin frame ordering while an earlier runtime call is pending', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let resolveSend = (_value: unknown): void => {}
    const send = new Promise((resolve) => {
      resolveSend = resolve
    })
    const call = vi
      .fn()
      .mockImplementationOnce(() => send)
      .mockResolvedValueOnce({ ok: true, result: { updated: true, applied: true } })
    const client = {
      streamLocal: vi.fn(() => ({ done, close: resolveDone })),
      call
    } as unknown as RuntimeClient

    const bridge = runTerminalBridge({ client, terminal: 'term-1', input, output })
    input.write(
      `${JSON.stringify({ type: 'input', data: 'first' })}\n${JSON.stringify({ type: 'resize', cols: 100, rows: 30 })}\n`
    )
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[0]).toBe('terminal.send')
    resolveSend({
      ok: true,
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 5 } }
    })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls[1]?.[0]).toBe('terminal.updateViewport')
    input.write('{"type":"close"}\n')
    await bridge
  })

  it('reports a rejected viewport update as a structured error', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const client = {
      streamLocal: vi.fn(() => ({ done, close: resolveDone })),
      call: vi.fn().mockResolvedValue({
        ok: true,
        result: { updated: false, applied: false }
      })
    } as unknown as RuntimeClient
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(String(chunk)))

    const bridge = runTerminalBridge({ client, terminal: 'term-1', input, output })
    input.write('{"type":"resize","cols":80,"rows":24}\n')
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    input.write('{"type":"close"}\n')
    await bridge

    expect(JSON.parse(chunks[0]!)).toEqual({
      type: 'error',
      error: {
        code: 'terminal_viewport_rejected',
        message: 'Terminal viewport update was rejected.'
      }
    })
  })

  it('reports a failed viewport call as a structured error', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const client = {
      streamLocal: vi.fn(() => ({ done, close: resolveDone })),
      call: vi.fn().mockRejectedValue(new Error('viewport failed'))
    } as unknown as RuntimeClient
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(String(chunk)))

    const bridge = runTerminalBridge({ client, terminal: 'term-1', input, output })
    input.write('{"type":"resize","cols":80,"rows":24}\n')
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    input.write('{"type":"close"}\n')
    await bridge

    expect(JSON.parse(chunks[0]!)).toEqual({
      type: 'error',
      error: { code: 'terminal_bridge_error', message: 'viewport failed' }
    })
  })

  it('drains final stream frames before returning without ending stdout', async () => {
    const input = new PassThrough()
    const output = new GatedWritable()
    let emit = (_event: RuntimeRpcSuccess<StreamEvent>): void => {}
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const client = {
      streamLocal: vi.fn((_method, _params, onEvent) => {
        emit = onEvent
        return { done, close: vi.fn() }
      }),
      call: vi.fn()
    } as unknown as RuntimeClient

    let settled = false
    const bridge = runTerminalBridge({
      client,
      terminal: 'term-1',
      input,
      output
    }).then(() => {
      settled = true
    })
    emit(success({ type: 'data', chunk: 'final data' }))
    emit(success({ type: 'error', error: { message: 'final error' } }))
    emit(success({ type: 'end' }))
    resolveDone()

    await vi.waitFor(() => expect(output.writes).toHaveLength(1))
    expect(settled).toBe(false)
    output.releases.shift()?.()
    await vi.waitFor(() => expect(output.writes).toHaveLength(2))
    expect(settled).toBe(false)
    output.releases.shift()?.()
    await vi.waitFor(() => expect(output.writes).toHaveLength(3))
    expect(settled).toBe(false)
    output.releases.shift()?.()
    await bridge

    expect(output.writes.join('')).toBe(
      `${JSON.stringify({ type: 'data', chunk: 'final data' })}\n${JSON.stringify({ type: 'error', error: { message: 'final error' } })}\n${JSON.stringify({ type: 'end' })}\n`
    )
    expect(output.writableEnded).toBe(false)
  })

  it('uses a distinct client identity for each bridge', async () => {
    const ids: string[] = []
    const bridges = [1, 2].map(() => {
      const input = new PassThrough()
      const output = new PassThrough()
      let resolveDone = (): void => {}
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const client = {
        streamLocal: vi.fn((_method, params) => {
          ids.push(params.client.id)
          return { done, close: resolveDone }
        }),
        call: vi.fn()
      } as unknown as RuntimeClient
      const bridge = runTerminalBridge({
        client,
        terminal: 'term-1',
        input,
        output
      })
      input.write('{"type":"close"}\n')
      return bridge
    })

    await Promise.all(bridges)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('reports terminal input refusal as a structured rejection event', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const client = {
      streamLocal: vi.fn(() => ({ done, close: resolveDone })),
      call: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          send: {
            handle: 'term-1',
            accepted: false,
            bytesWritten: 0,
            refusedReason: 'permission'
          }
        }
      })
    } as unknown as RuntimeClient
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(String(chunk)))

    const bridge = runTerminalBridge({
      client,
      terminal: 'term-1',
      input,
      output
    })
    input.write(`${JSON.stringify({ type: 'input', data: 'blocked' })}\n`)
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    input.write('{"type":"close"}\n')
    await bridge

    expect(JSON.parse(chunks[0]!)).toEqual({
      type: 'input-rejected',
      error: {
        code: 'terminal_input_rejected',
        message: 'Terminal input was rejected: permission.',
        data: { reason: 'permission' }
      }
    })
  })

  it('reports malformed stdin as a structured stream error', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const client = {
      streamLocal: vi.fn(() => ({ done, close: resolveDone })),
      call: vi.fn()
    } as unknown as RuntimeClient
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(String(chunk)))

    const bridge = runTerminalBridge({
      client,
      terminal: 'term-1',
      input,
      output
    })
    input.write('not-json\n')
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    input.write('{"type":"close"}\n')
    await bridge

    expect(JSON.parse(chunks[0]!)).toMatchObject({
      type: 'error',
      error: { code: 'invalid_argument' }
    })
  })
})

function success(result: StreamEvent): RuntimeRpcSuccess<StreamEvent> {
  return {
    id: 'stream-1',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-1' }
  }
}
