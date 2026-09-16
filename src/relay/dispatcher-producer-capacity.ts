import { RelayDispatcherProducerTransport } from './dispatcher-producer-transport'

export abstract class RelayDispatcherProducerCapacity extends RelayDispatcherProducerTransport {
  maxLegacyPtyDataChars(
    params: Record<string, unknown>,
    data: string,
    limit = data.length
  ): number {
    const clients = this.activeClients().filter((client) =>
      this.admitsPtyDataPublication(client.id, params)
    )
    const max = Math.min(data.length, limit)
    if (clients.length === 0) {
      return max
    }
    if (!(max > 0)) {
      return 0
    }
    const fitsAll = (bytes: number): boolean =>
      clients.every((client) => bytes <= client.writer.producerFrameCapacity)
    const sizeFrame = (chunk: string): number =>
      this.estimateFrameBytes({
        jsonrpc: '2.0',
        method: 'pty.data',
        params: { ...params, data: chunk }
      })
    // Fast path: the whole chunk usually fits — one encode instead of log2(n).
    if (fitsAll(sizeFrame(data.slice(0, max)))) {
      return max
    }
    // Exact per-step size: only the escaped data string varies; its quotes are in baseBytes.
    const baseBytes = sizeFrame('')
    const bytesFor = (chars: number): number =>
      baseBytes + Buffer.byteLength(JSON.stringify(data.slice(0, chars))) - 2
    let low = 0
    let high = max
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (fitsAll(bytesFor(mid))) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return low
  }

  activeClientIds(): number[] {
    return this.activeClients().map((client) => client.id)
  }

  // Why: signed on purpose — `budget >= 0` is an exact fits-check that a floored budget cannot express.
  producerEnvelopeBudget(
    method: string,
    params: Record<string, unknown>,
    clientId?: number
  ): number {
    if (clientId !== undefined) {
      const client = this.clients.get(clientId)
      // Why: a detached or closed target has no room at all — reporting infinite capacity passes a
      // fits-check and the frame is then dropped by the publish seam instead.
      if (!client || client.closed) {
        return Number.MIN_SAFE_INTEGER
      }
      return (
        client.writer.producerFrameCapacity -
        this.estimateFrameBytes({ jsonrpc: '2.0', method, params })
      )
    }
    const targets = this.activeClients()
    if (targets.length === 0) {
      return Number.MAX_SAFE_INTEGER
    }
    const frameBytes = this.estimateFrameBytes({ jsonrpc: '2.0', method, params })
    return Math.min(...targets.map((client) => client.writer.producerFrameCapacity - frameBytes))
  }

  producerDataBudget(
    method: string,
    paramsWithoutData: Record<string, unknown>,
    clientId?: number
  ): number {
    return Math.max(
      0,
      this.producerEnvelopeBudget(method, { ...paramsWithoutData, data: '' }, clientId)
    )
  }

  // notify() broadcasts one frame, so chunks must fit the smallest attached capacity.
  broadcastProducerFrameCapacity(): number | undefined {
    if (this.disposed) {
      return undefined
    }
    const clients = this.activeClients()
    if (clients.length === 0) {
      return undefined
    }
    return Math.min(...clients.map((client) => client.writer.producerFrameCapacity))
  }

  notificationFrameBytes(method: string, params?: Record<string, unknown>): number {
    return this.estimateFrameBytes({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    })
  }
}
