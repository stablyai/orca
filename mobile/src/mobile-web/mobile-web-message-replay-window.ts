export class MobileWebMessageReplayWindow {
  private readonly ids = new Set<string>()

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('mobile_web_replay_window_invalid')
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  remember(id: string): void {
    if (this.ids.delete(id)) {
      this.ids.add(id)
      return
    }
    this.ids.add(id)
    if (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) {
        this.ids.delete(oldest)
      }
    }
  }

  clear(): void {
    this.ids.clear()
  }
}
