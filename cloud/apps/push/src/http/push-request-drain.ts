import type { MiddlewareHandler } from 'hono'

export class PushRequestDrain {
  private draining = false
  private active = 0
  private readonly waiters = new Set<() => void>()

  readonly middleware: MiddlewareHandler = async (context, next) => {
    if (this.draining) return context.json({ error: 'shutting_down' }, 503)
    this.active++
    try {
      await next()
    } finally {
      this.active--
      if (this.active === 0) {
        for (const resolve of this.waiters) resolve()
        this.waiters.clear()
      }
    }
  }

  begin(): Promise<void> {
    this.draining = true
    return this.active === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.add(resolve))
  }
}
