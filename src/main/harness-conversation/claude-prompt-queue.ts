import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export class ClaudePromptQueue {
  private readonly messages: SDKUserMessage[] = []
  private readonly waiters: ((message: SDKUserMessage | null) => void)[] = []
  private closed = false

  enqueue(message: SDKUserMessage): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(message)
    } else {
      this.messages.push(message)
    }
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter(null)
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message =
        this.messages.shift() ??
        (await new Promise<SDKUserMessage | null>((resolve) => this.waiters.push(resolve)))
      if (message) {
        yield message
      }
    }
  }
}
