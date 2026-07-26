export const MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT = 256
export const MAX_ACTIVE_RELAY_REQUESTS = 1024
// Why: handlers retain parsed params until settlement, so cardinality alone
// cannot bound a burst of near-maximum relay frames.
export const MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT = 32 * 1024 * 1024
export const MAX_ACTIVE_RELAY_REQUEST_BYTES = 64 * 1024 * 1024

type ClientRequestAbortEntry = {
  controller: AbortController
  retainedBytes: number
}

export type ClientRequestAbortKey = {
  clientId: number
  requestId: number
}

export class RelayRequestAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayRequestAdmissionError'
  }
}

export class ClientRequestAborts {
  private readonly entriesByClient = new Map<number, Map<number, ClientRequestAbortEntry>>()
  private activeRequestCount = 0
  private activeRequestBytes = 0

  create(
    clientId: number,
    requestId: number,
    retainedBytes = 0
  ): { key: ClientRequestAbortKey; controller: AbortController } {
    const clientEntries = this.entriesByClient.get(clientId)
    if (clientEntries?.has(requestId)) {
      throw new RelayRequestAdmissionError(`Duplicate active relay request id ${requestId}`)
    }
    if ((clientEntries?.size ?? 0) >= MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT) {
      throw new RelayRequestAdmissionError(
        `Relay client active request limit of ${MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT} reached`
      )
    }
    if (this.activeRequestCount >= MAX_ACTIVE_RELAY_REQUESTS) {
      throw new RelayRequestAdmissionError(
        `Relay active request limit of ${MAX_ACTIVE_RELAY_REQUESTS} reached`
      )
    }
    const normalizedBytes = Math.max(0, retainedBytes)
    const clientBytes = sumRetainedBytes(clientEntries?.values())
    if (clientBytes + normalizedBytes > MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT) {
      throw new RelayRequestAdmissionError(
        `Relay client active request payload limit of ${MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT} bytes exceeded`
      )
    }
    if (this.activeRequestBytes + normalizedBytes > MAX_ACTIVE_RELAY_REQUEST_BYTES) {
      throw new RelayRequestAdmissionError(
        `Relay active request payload limit of ${MAX_ACTIVE_RELAY_REQUEST_BYTES} bytes exceeded`
      )
    }

    const controller = new AbortController()
    const entries = clientEntries ?? new Map<number, ClientRequestAbortEntry>()
    entries.set(requestId, { controller, retainedBytes: normalizedBytes })
    this.entriesByClient.set(clientId, entries)
    this.activeRequestCount += 1
    this.activeRequestBytes += normalizedBytes
    return { key: { clientId, requestId }, controller }
  }

  get(clientId: number, requestId: number): AbortController | undefined {
    return this.entriesByClient.get(clientId)?.get(requestId)?.controller
  }

  delete(key: ClientRequestAbortKey): void {
    const clientEntries = this.entriesByClient.get(key.clientId)
    const entry = clientEntries?.get(key.requestId)
    if (!clientEntries || !entry) {
      return
    }
    clientEntries.delete(key.requestId)
    this.activeRequestCount -= 1
    this.activeRequestBytes -= entry.retainedBytes
    if (clientEntries.size === 0) {
      this.entriesByClient.delete(key.clientId)
    }
  }

  abortClient(clientId: number): void {
    const clientEntries = this.entriesByClient.get(clientId)
    if (!clientEntries) {
      return
    }
    for (const [requestId, entry] of clientEntries) {
      entry.controller.abort()
      this.delete({ clientId, requestId })
    }
  }

  abortAll(): void {
    for (const clientEntries of this.entriesByClient.values()) {
      for (const entry of clientEntries.values()) {
        entry.controller.abort()
      }
    }
    this.entriesByClient.clear()
    this.activeRequestCount = 0
    this.activeRequestBytes = 0
  }
}

function sumRetainedBytes(entries?: Iterable<ClientRequestAbortEntry>): number {
  let total = 0
  for (const entry of entries ?? []) {
    total += entry.retainedBytes
  }
  return total
}
