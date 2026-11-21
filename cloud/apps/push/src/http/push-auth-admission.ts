// Bound unauthenticated database lookups independently of Cloud Run HTTP concurrency.
export class PushAuthAdmission {
  private active = 0
  private readonly waiting: (() => void)[] = []

  async run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.active >= 4) {
      if (this.waiting.length >= 32) return null
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    } else {
      this.active++
    }
    try {
      return await operation()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
