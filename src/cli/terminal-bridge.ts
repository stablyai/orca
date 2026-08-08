import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { RuntimeTerminalSend } from '../shared/runtime-types'
import type { RuntimeClient } from './runtime-client'
import type { LocalRuntimeStream } from './runtime/local-stream-transport'
import { RuntimeClientError, type RuntimeRpcSuccess } from './runtime/types'
import { TerminalBridgeNdjsonReader, TerminalBridgeNdjsonWriter } from './terminal-bridge-ndjson'

export type TerminalBridgeOptions = {
  client: RuntimeClient
  terminal: string
  input: Readable
  output: Writable
}

type BridgeInput =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' }
type StreamEvent = Record<string, unknown> & { type?: unknown }
type ViewportUpdateResult = { updated: boolean; applied: boolean }

const PASSIVE_INITIAL_VIEWPORT = { cols: 80, rows: 24 }
const MIN_VIEWPORT_COLS = 20
const MAX_VIEWPORT_COLS = 240
const MIN_VIEWPORT_ROWS = 8
const MAX_VIEWPORT_ROWS = 120

export async function runTerminalBridge({
  client,
  terminal,
  input,
  output
}: TerminalBridgeOptions): Promise<void> {
  const clientId = `orca-cli-bridge-${randomUUID()}`
  let closing = false
  let fatalError: Error | null = null
  let streamClosed = false
  let stream: LocalRuntimeStream | null = null
  let reader: TerminalBridgeNdjsonReader | null = null
  let resolveFatal = (_error: Error): void => {}
  const fatal = new Promise<Error>((resolve) => {
    resolveFatal = resolve
  })

  const closeStream = (): void => {
    if (streamClosed || !stream) {
      return
    }
    streamClosed = true
    stream.close()
  }
  const requestClose = (): void => {
    if (closing) {
      return
    }
    closing = true
    reader?.close()
    closeStream()
  }
  const fail = (error: Error, emit: boolean): void => {
    if (fatalError) {
      return
    }
    fatalError = error
    if (emit) {
      writer.write(errorEvent(error))
    }
    requestClose()
    resolveFatal(error)
  }
  const writer = new TerminalBridgeNdjsonWriter({
    output,
    onError: (error) => fail(error, false)
  })

  try {
    stream = client.streamLocal<StreamEvent>(
      'terminal.subscribe',
      {
        terminal,
        client: { id: clientId, type: 'desktop' },
        // Why: register a passive, stream-owned viewport floor so later resize frames can claim it
        // through terminal.updateViewport and stream cleanup releases it with the same client identity.
        viewport: PASSIVE_INITIAL_VIEWPORT,
        capabilities: { desktopViewportClaims: 1 }
      },
      (response: RuntimeRpcSuccess<StreamEvent>) => {
        writer.write(response.result)
        if (response.result.type === 'end') {
          closing = true
          reader?.close()
        }
      }
    )

    reader = new TerminalBridgeNdjsonReader({
      input,
      onLine: async (line) => {
        if (closing) {
          return
        }
        let frame: BridgeInput
        try {
          frame = parseInputFrame(line)
        } catch (error) {
          writer.write(errorEvent(error))
          return
        }
        if (frame.type === 'close') {
          requestClose()
          return
        }
        try {
          if (frame.type === 'resize') {
            const response = await client.call<ViewportUpdateResult>('terminal.updateViewport', {
              terminal,
              client: { id: clientId, type: 'desktop' },
              viewport: { cols: frame.cols, rows: frame.rows },
              claim: true
            })
            if (!response.result.updated || !response.result.applied) {
              writer.write(viewportRejectedEvent())
            }
            return
          }
          if (!frame.data) {
            return
          }
          const response = await client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
            terminal,
            text: frame.data,
            enter: false,
            interrupt: false,
            client: { id: clientId, type: 'desktop' }
          })
          if (!response.result.send.accepted) {
            writer.write(inputRejectedEvent(response.result.send.refusedReason))
          }
        } catch (error) {
          writer.write(errorEvent(error))
        }
      },
      onEnd: requestClose,
      onError: (error) => fail(error, true)
    })

    const outcome = await Promise.race([stream.done.then(() => null), fatal])
    if (outcome) {
      throw outcome
    }
  } catch (error) {
    if (!fatalError) {
      writer.write(errorEvent(error))
    }
    process.exitCode = 1
  } finally {
    closing = true
    reader?.close()
    closeStream()
    await writer.finish()
  }
}

function parseInputFrame(line: string): BridgeInput {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new RuntimeClientError('invalid_argument', 'Terminal bridge input must be NDJSON.')
  }
  if (!value || typeof value !== 'object') {
    throw new RuntimeClientError('invalid_argument', 'Terminal bridge input must be an object.')
  }
  const frame = value as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }
  if (frame.type === 'close') {
    return { type: 'close' }
  }
  if (frame.type === 'input' && typeof frame.data === 'string') {
    return { type: 'input', data: frame.data }
  }
  if (frame.type === 'resize') {
    if (
      !Number.isInteger(frame.cols) ||
      !Number.isInteger(frame.rows) ||
      (frame.cols as number) < MIN_VIEWPORT_COLS ||
      (frame.cols as number) > MAX_VIEWPORT_COLS ||
      (frame.rows as number) < MIN_VIEWPORT_ROWS ||
      (frame.rows as number) > MAX_VIEWPORT_ROWS
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Terminal bridge resize requires integer cols ${MIN_VIEWPORT_COLS}-${MAX_VIEWPORT_COLS} and rows ${MIN_VIEWPORT_ROWS}-${MAX_VIEWPORT_ROWS}.`
      )
    }
    return { type: 'resize', cols: frame.cols as number, rows: frame.rows as number }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Terminal bridge input requires an input, resize, or close frame.'
  )
}

function viewportRejectedEvent(): StreamEvent {
  return {
    type: 'error',
    error: {
      code: 'terminal_viewport_rejected',
      message: 'Terminal viewport update was rejected.'
    }
  }
}

function inputRejectedEvent(reason: RuntimeTerminalSend['refusedReason']): StreamEvent {
  return {
    type: 'input-rejected',
    error: {
      code: 'terminal_input_rejected',
      message: reason ? `Terminal input was rejected: ${reason}.` : 'Terminal input was rejected.',
      ...(reason ? { data: { reason } } : {})
    }
  }
}

function errorEvent(error: unknown): StreamEvent {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof RuntimeClientError ? error.code : 'terminal_bridge_error'
  return {
    type: 'error',
    error: {
      code,
      message,
      ...(error instanceof RuntimeClientError && error.data !== undefined
        ? { data: error.data }
        : {})
    }
  }
}
