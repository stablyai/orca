import { RELAY_ADMISSION_BUDGETS, RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import { closeRelayWebSocket } from './relay-websocket-close.js'

type QueuedFrame = { data: RawData; binary: boolean; bytes: number }

export class ProcessQueuedByteBudget {
  private queued = 0

  reserve(bytes: number): boolean {
    if (this.queued + bytes > RELAY_ADMISSION_BUDGETS.maxProcessQueuedBytes) return false
    this.queued += bytes
    return true
  }

  release(bytes: number): void {
    this.queued = Math.max(0, this.queued - bytes)
  }

  current(): number {
    return this.queued
  }
}

function frameBytes(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0)
  return data.byteLength
}

function transport(socket: WebSocket): { pause(): void; resume(): void; setNoDelay(value: boolean): void } | null {
  return (
    socket as WebSocket & {
      _socket?: { pause(): void; resume(): void; setNoDelay(value: boolean): void }
    }
  )._socket ?? null
}

export type SpliceCloseInfo = { code: number; reason: string; trigger: string }

// The ws receiver kills a connection whose frame exceeds maxPayload with this
// message; surfacing it separately is what makes catalog-growth kills visible.
function errorTrigger(side: 'client' | 'host', error: Error): string {
  return /max payload/i.test(error.message) ? `${side}-oversize-frame` : `${side}-error`
}

export function wireSplice(input: {
  client: WebSocket
  host: WebSocket
  budget: ProcessQueuedByteBudget
  onClose: () => void
  onForwardedBytes?: (bytes: number) => void
  onClosed?: (closeInfo: SpliceCloseInfo) => void
}): (code?: number, reason?: string) => void {
  let closed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const cleanups: Array<() => void> = []

  const close = (
    code: number = RELAY_CLOSE_CODE.PEER_DROPPED,
    reason = 'peer connection dropped',
    trigger = 'external'
  ): void => {
    if (closed) return
    closed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const cleanup of cleanups) cleanup()
    closeRelayWebSocket(input.client, code, reason)
    closeRelayWebSocket(input.host, code, reason)
    input.onClosed?.({ code, reason, trigger })
    input.onClose()
  }

  const direction = (source: WebSocket, target: WebSocket): void => {
    const queue: QueuedFrame[] = []
    let queuedBytes = 0
    let wedgedSince: number | null = null
    cleanups.push(() => {
      input.budget.release(queuedBytes)
      queuedBytes = 0
      queue.length = 0
      transport(source)?.resume()
    })

    const flush = (): void => {
      if (closed) return
      if (target.readyState !== target.OPEN || source.readyState !== source.OPEN) {
        close(undefined, undefined, 'peer-gone')
        return
      }
      while (
        queue.length > 0 &&
        target.bufferedAmount <= RELAY_ADMISSION_BUDGETS.spliceLowWaterBytes
      ) {
        const frame = queue.shift()!
        queuedBytes -= frame.bytes
        input.budget.release(frame.bytes)
        target.send(frame.data, { binary: frame.binary })
      }
      if (queue.length === 0) {
        wedgedSince = null
        transport(source)?.resume()
        return
      }
      if (
        wedgedSince !== null &&
        Date.now() - wedgedSince >= RELAY_ADMISSION_BUDGETS.spliceWedgedTimeoutMs
      ) {
        close(RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'wedged relay link', 'wedged')
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        flush()
      }, 25)
      timers.add(timer)
    }

    source.on('message', (data, binary) => {
      if (closed) return
      const bytes = frameBytes(data)
      if (
        queue.length === 0 &&
        target.readyState === target.OPEN &&
        target.bufferedAmount <= RELAY_ADMISSION_BUDGETS.spliceHighWaterBytes
      ) {
        target.send(data, { binary })
        input.onForwardedBytes?.(bytes)
        return
      }
      if (
        queuedBytes + bytes > RELAY_ADMISSION_BUDGETS.spliceHardQueuedBytes ||
        !input.budget.reserve(bytes)
      ) {
        close(RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'relay queue limit exceeded', 'queue-limit')
        return
      }
      queue.push({ data, binary, bytes })
      queuedBytes += bytes
      input.onForwardedBytes?.(bytes)
      wedgedSince ??= Date.now()
      transport(source)?.pause()
      if (queue.length === 1) flush()
    })
  }

  transport(input.client)?.setNoDelay(true)
  transport(input.host)?.setNoDelay(true)
  direction(input.client, input.host)
  direction(input.host, input.client)
  input.client.once('close', () => close(undefined, undefined, 'client-closed'))
  input.host.once('close', () => close(undefined, undefined, 'host-closed'))
  input.client.once('error', (error) => close(undefined, undefined, errorTrigger('client', error)))
  input.host.once('error', (error) => close(undefined, undefined, errorTrigger('host', error)))
  return close
}
