export class ClientRequestAborts {
  private readonly requests = new Map<
    string,
    { controller: AbortController; publishCancellationSettlement: boolean }
  >()

  create(clientId: number, requestId: number): { key: string; controller: AbortController } {
    const key = this.key(clientId, requestId)
    const controller = new AbortController()
    this.requests.set(key, { controller, publishCancellationSettlement: false })
    return { key, controller }
  }

  cancel(
    clientId: number,
    requestId: number,
    publishSettlement: boolean,
    abandonSettlement: boolean
  ): void {
    const request = this.requests.get(this.key(clientId, requestId))
    if (!request) {
      return
    }
    request.publishCancellationSettlement = abandonSettlement
      ? false
      : request.publishCancellationSettlement || publishSettlement
    request.controller.abort()
  }

  shouldPublishCancellationSettlement(key: string): boolean {
    return this.requests.get(key)?.publishCancellationSettlement === true
  }

  allowCancellationSettlement(key: string): void {
    const request = this.requests.get(key)
    if (request) {
      request.publishCancellationSettlement = true
    }
  }

  delete(key: string): void {
    this.requests.delete(key)
  }

  abortClient(clientId: number): void {
    const prefix = `${clientId}:`
    for (const [key, request] of this.requests) {
      if (!key.startsWith(prefix)) {
        continue
      }
      request.controller.abort()
      this.requests.delete(key)
    }
  }

  abortAll(): void {
    for (const [, request] of this.requests) {
      request.controller.abort()
    }
    this.requests.clear()
  }

  private key(clientId: number, requestId: number): string {
    return `${clientId}:${requestId}`
  }
}
