/** Opaque handle returned by `create`, so a release needs no string parsing to find its owner. */
export type ClientRequestAbortHandle = {
  readonly clientId: number
  readonly requestId: number
}

export class ClientRequestAborts {
  // Why indexed by client instead of one flat map under composite `${clientId}:${requestId}` keys:
  // abortClient runs on every closeClient and every setWrite, and against a flat map it had to scan
  // every entry to find one client's. A scan with an early break cannot fix that -- the matching
  // keys are scattered through the map, so any correct loop still visits every entry, which made a
  // full churn of N clients cost K*N*(N+1)/2 visits. Only an index makes a teardown proportional to
  // what that client actually owns.
  private readonly byClient = new Map<number, Map<number, AbortController>>()

  create(
    clientId: number,
    requestId: number
  ): { key: ClientRequestAbortHandle; controller: AbortController } {
    const controller = new AbortController()
    let requests = this.byClient.get(clientId)
    if (!requests) {
      requests = new Map<number, AbortController>()
      this.byClient.set(clientId, requests)
    }
    requests.set(requestId, controller)
    return { key: { clientId, requestId }, controller }
  }

  get(clientId: number, requestId: number): AbortController | undefined {
    return this.byClient.get(clientId)?.get(requestId)
  }

  delete(key: ClientRequestAbortHandle): void {
    const requests = this.byClient.get(key.clientId)
    if (!requests) {
      return
    }
    requests.delete(key.requestId)
    // Why drop the empty bucket: otherwise a churned client leaves an entry behind for the life of
    // the relay, which is the retention the index exists to avoid.
    if (requests.size === 0) {
      this.byClient.delete(key.clientId)
    }
  }

  abortClient(clientId: number): void {
    const requests = this.byClient.get(clientId)
    if (!requests) {
      return
    }
    // Unlink before aborting: an abort listener that reaches back in must not see a half-emptied
    // bucket, and the whole bucket is going regardless.
    this.byClient.delete(clientId)
    for (const controller of requests.values()) {
      controller.abort()
    }
  }

  abortAll(): void {
    const buckets = Array.from(this.byClient.values())
    this.byClient.clear()
    for (const requests of buckets) {
      for (const controller of requests.values()) {
        controller.abort()
      }
    }
  }
}
