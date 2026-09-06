import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import {
  MobileWebTerminalEventState,
  type MobileWebTerminalEffect
} from '../../../src/mobile-web/src/mobile-web-terminal-event-state'
import { MobileWebTerminalRequestScheduler } from '../../../src/mobile-web/src/mobile-web-terminal-request-scheduler'
import { MOBILE_WEB_TERMINAL_MAX_INPUT_BYTES } from '../../../src/shared/mobile-web/terminal-stream-contract'
import type {
  HostSessionTerminalOperations,
  HostSessionTerminalStreamEvent
} from './host-session-terminal-operations'

type WebTerminalStream = {
  scheduler: MobileWebTerminalRequestScheduler
  unsubscribe: () => void
}

export function webHostSessionTerminalOperations(
  client: MobileWebBridgeClient
): HostSessionTerminalOperations {
  const streams = new Map<string, WebTerminalStream>()
  return {
    subscribe(args, onEvent, onError) {
      streams.get(args.terminalId)?.unsubscribe()
      let eventState: MobileWebTerminalEventState
      let scheduler: MobileWebTerminalRequestScheduler
      const subscription = client.terminalSubscribe(
        {
          operation: 'subscribe',
          workspaceId: args.workspaceId,
          tabId: args.terminalId,
          viewport: args.viewport ?? { cols: 80, rows: 24 },
          visible: args.visible,
          ...(args.capabilities.mobileInputLeaseOnly === 1 ? { leaseOnly: true as const } : {})
        },
        (event) => {
          const effect = eventState.apply(event)
          applyWebTerminalEffect(effect, scheduler, onEvent)
        },
        onError
      )
      eventState = new MobileWebTerminalEventState(subscription.streamId)
      scheduler = new MobileWebTerminalRequestScheduler(client, subscription.streamId, onError)
      const stream: WebTerminalStream = {
        scheduler,
        unsubscribe: () => {
          if (streams.get(args.terminalId) === stream) {
            streams.delete(args.terminalId)
          }
          scheduler.dispose()
          subscription.unsubscribe()
        }
      }
      streams.set(args.terminalId, stream)
      void subscription.ready.then(
        () => scheduler.markBridgeReady(),
        () => onError()
      )
      return stream.unsubscribe
    },
    acknowledge(terminalId, throughSequence) {
      streams.get(terminalId)?.scheduler.acknowledge(throughSequence)
    },
    async sendInput(terminalId, text, enter) {
      const scheduler = streams.get(terminalId)?.scheduler
      if (!scheduler) {
        return false
      }
      const bytes = new TextEncoder().encode(enter ? `${text}\r` : text)
      for (const chunk of chunkBytes(bytes, MOBILE_WEB_TERMINAL_MAX_INPUT_BYTES)) {
        if (!(await scheduler.sendInputAsync('input', base64(chunk)))) {
          return false
        }
      }
      return bytes.byteLength > 0
    },
    async sendQueryReply(terminalId, bytes) {
      const scheduler = streams.get(terminalId)?.scheduler
      if (!scheduler) {
        return false
      }
      return scheduler.sendInputAsync('queryReply', base64(new TextEncoder().encode(bytes)))
    },
    setDisplayMode(terminalId, mode, viewport) {
      return (
        streams.get(terminalId)?.scheduler.setDisplayMode(mode, viewport) ?? Promise.resolve(false)
      )
    },
    clear(terminalId) {
      return streams.get(terminalId)?.scheduler.clear() ?? Promise.resolve(false)
    },
    rename(terminalId, title) {
      return streams.get(terminalId)?.scheduler.rename(title) ?? Promise.resolve(false)
    },
    pasteClipboard(terminalId, bracketedPaste) {
      return (
        streams.get(terminalId)?.scheduler.pasteClipboard(bracketedPaste) ?? Promise.resolve(null)
      )
    },
    attachImage(terminalId, source) {
      return streams.get(terminalId)?.scheduler.attachImage(source) ?? Promise.resolve(null)
    }
  }
}

function applyWebTerminalEffect(
  effect: MobileWebTerminalEffect,
  scheduler: MobileWebTerminalRequestScheduler,
  onEvent: (event: HostSessionTerminalStreamEvent) => void
): void {
  if (effect.type === 'ready') {
    scheduler.markHostReady(effect.queryReplyNegotiated)
    onEvent({
      type: 'subscribed',
      cols: effect.viewport.cols,
      rows: effect.viewport.rows
    })
  } else if (effect.type === 'displayMode') {
    onEvent({ type: 'metadata', displayMode: effect.displayMode })
  } else if (effect.type === 'write') {
    onEvent({
      type: 'data',
      chunk: effect.data,
      throughSequence: effect.throughSequence
    })
  } else if (effect.type === 'replace') {
    scheduler.markResynced()
    onEvent({
      type: effect.kind === 'initial' ? 'scrollback' : 'resized',
      cols: effect.viewport.cols,
      rows: effect.viewport.rows,
      serialized: effect.data,
      preserveScroll: effect.kind === 'resize',
      throughSequence: effect.throughSequence,
      ...(effect.oscLinks ? { oscLinks: effect.oscLinks } : {})
    })
  } else if (effect.type === 'resized') {
    onEvent({
      type: 'resized',
      cols: effect.viewport.cols,
      rows: effect.viewport.rows
    })
  } else if (effect.type === 'resync') {
    scheduler.requestResync(effect.fromSequence, effect.reason)
  } else if (effect.type === 'closed') {
    onEvent({ type: 'end' })
  } else if (effect.type === 'error') {
    onEvent({ type: 'error' })
  }
}

function chunkBytes(bytes: Uint8Array, maxBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += maxBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + maxBytes, bytes.byteLength)))
  }
  return chunks
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
