export class ClientRequestAborts {
  private readonly controllers = new Map<string, AbortController>()

  create(clientId: number, requestId: number): { key: string; controller: AbortController } {
    const key = this.key(clientId, requestId)
    const controller = new AbortController()
    this.controllers.set(key, controller)
    return { key, controller }
  }

  get(clientId: number, requestId: number): AbortController | undefined {
    return this.controllers.get(this.key(clientId, requestId))
  }

  delete(key: string): void {
    this.controllers.delete(key)
  }

  abortClient(clientId: number): void {
    const prefix = `${clientId}:`
    for (const [key, controller] of this.controllers) {
      if (!key.startsWith(prefix)) {
        continue
      }
      controller.abort()
      this.controllers.delete(key)
    }
  }

  private key(clientId: number, requestId: number): string {
    return `${clientId}:${requestId}`
  }
}
