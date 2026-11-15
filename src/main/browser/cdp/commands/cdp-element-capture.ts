// A helper-resolved remote object; its session is the debugger's, undefined for the page itself.
export type CapturedElement = { objectId: string; sessionId: string | undefined }

/** Records the element the helper's calls run on, so Orca can act on that exact node. */
export class CdpElementCapture {
  // Undefined while not capturing.
  private captured: CapturedElement | null | undefined

  start(): void {
    this.captured = null
  }

  stop(): CapturedElement | null {
    const captured = this.captured ?? null
    this.captured = undefined
    return captured
  }

  observe(method: string, params: Record<string, unknown> | undefined, sessionId?: string): void {
    const objectId = params?.objectId
    if (
      this.captured !== undefined &&
      method === 'Runtime.callFunctionOn' &&
      typeof objectId === 'string'
    ) {
      this.captured = { objectId, sessionId }
    }
  }
}
