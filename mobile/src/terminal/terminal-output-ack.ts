import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { TerminalWebViewHandle } from './terminal-webview-contract'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWriteCoalescer } from './terminal-write-coalescer'

// Ack in batches: per-chunk acks would double the phone's request rate during a flood.
const ACK_BATCH_UNITS = 128 * 1024
// A tail under the batch still needs credit back, or a later large chunk waits on it forever.
// Measured from the first unacked unit, so a steady trickle can't postpone it and typing echoes share one ack.
const ACK_DELAY_MS = 250

export type TerminalOutputAck = {
  /** The `terminal.subscribe` capabilities, with `outputAck` when this terminal can ack. */
  capabilities: Record<string, 1>
  /** Reads the host's `subscribed` reply; a replayed subscribe brings a new token and forgets the old stream's debt. */
  start: (subscribed: Record<string, unknown>) => void
  /** For a credited stream's Output event: the callback to run once xterm has parsed it, or once it is dropped unwritten. */
  owe: (event: Record<string, unknown>) => (() => void) | null
}

/** Returns parsed Output units (UTF-16, as received) to the host's per-stream credit window. */
export function createTerminalOutputAck(args: {
  client: Pick<RpcClient, 'sendRequest'>
  capabilities: Record<string, 1>
  // Only a terminal that reports what xterm parsed may ask; a native route can't, and its stream would stall.
  terminal: TerminalWebViewHandle | undefined
  isCurrent: () => boolean
}): TerminalOutputAck {
  const asks = args.terminal?.writeWithParseAck !== undefined
  let streamToken: string | null = null
  let parsedUnits = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const cancelFlushTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const armFlush = () => {
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, ACK_DELAY_MS)
    }
  }

  function flush() {
    cancelFlushTimer()
    if (streamToken !== null && parsedUnits > 0 && args.isCurrent()) {
      const params = { streamToken, units: parsedUnits }
      void args.client.sendRequest('terminal.ackOutput', params).catch((error: unknown) => {
        // Retry a refused send (bridge request cap) on the timer, never inline: an inline refusal would spin in microtasks.
        if (!isRpcDeliveryUnknown(error) && params.streamToken === streamToken) {
          parsedUnits += params.units
          armFlush()
        }
      })
    }
    parsedUnits = 0
  }

  return {
    capabilities: asks ? { ...args.capabilities, outputAck: 1 } : args.capabilities,
    start(subscribed) {
      cancelFlushTimer()
      parsedUnits = 0
      // Credit only after the echo: a host that didn't echo refuses `terminal.ackOutput`.
      streamToken =
        asks && subscribed.outputAck === true && typeof subscribed.streamToken === 'string'
          ? subscribed.streamToken
          : null
    },
    owe(event) {
      const units = typeof event.chunk === 'string' ? event.chunk.length : 0
      if (streamToken === null || event.type !== 'data' || units === 0) {
        return null
      }
      // Tokens are unique per subscribe, so a replayed stream's token ignores the old stream's settles.
      const owedToken = streamToken
      return () => {
        if (owedToken !== streamToken) {
          return
        }
        parsedUnits += units
        if (parsedUnits >= ACK_BATCH_UNITS) {
          flush()
        } else {
          armFlush()
        }
      }
    }
  }
}

/** Writes one Output event; output that can't be written is settled at once so its credit is not lost. */
export function writeTerminalStreamOutput(args: {
  handle: string
  chunk: string
  terminal: TerminalWebViewHandle | undefined
  initialized: boolean
  settle: (() => void) | null
}): void {
  const { handle, chunk, terminal, settle } = args
  // Missing refs explain input-working/blank-output states after unmount or missing scrollback.
  if (!terminal) {
    console.log('[fit][session] data DROPPED — no terminal ref', {
      handle: handle.slice(-8),
      chunkLen: chunk.length,
      initialized: args.initialized
    })
    settle?.()
    return
  }
  if (!args.initialized) {
    console.log('[fit][session] data RECEIVED before scrollback', {
      handle: handle.slice(-8),
      chunkLen: chunk.length
    })
  }
  if (settle && terminal.writeWithParseAck) {
    terminal.writeWithParseAck(chunk, settle)
    return
  }
  terminal.write(chunk)
  settle?.()
}

/** The controller's write path. An in-process document keeps the callback a write carries, so only it
 * reports parsed output; `clear` settles writes the document will never parse. */
export function createTerminalDocumentWrites(
  post: (command: TerminalWebViewCommand) => void,
  { coalesce }: { coalesce?: boolean }
) {
  const coalescer = createTerminalWriteCoalescer((data) => post({ type: 'write', data }), {
    coalesce
  })
  const unparsed = new Set<() => void>()
  const writeWithParseAck = (data: string, onParsed: () => void) => {
    const settle = () => {
      if (unparsed.delete(settle)) {
        onParsed()
      }
    }
    unparsed.add(settle)
    post({ type: 'write', data, onParsed: settle })
  }
  return {
    ...coalescer,
    clear() {
      coalescer.clear()
      for (const settle of Array.from(unparsed)) {
        settle()
      }
    },
    // `coalesce: false` means an in-process document, whose posts keep the callback.
    parseAck: coalesce === false ? { writeWithParseAck } : {}
  }
}
