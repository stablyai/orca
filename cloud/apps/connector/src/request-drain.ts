import type { MiddlewareHandler } from 'hono'

// Refuses new requests once shutdown begins and resolves when the in-flight ones finish.
export class RequestDrain {
  private draining = false
  private active = 0
  private idle: (() => void) | null = null

  readonly middleware: MiddlewareHandler = async (context, next) => {
    if (this.draining) {
      return context.json({ error: 'shutting_down' }, 503)
    }
    this.active++
    try {
      await next()
    } finally {
      if (--this.active === 0) {
        this.idle?.()
      }
    }
  }

  begin(): Promise<void> {
    this.draining = true
    return this.active === 0 ? Promise.resolve() : new Promise((resolve) => (this.idle = resolve))
  }
}
