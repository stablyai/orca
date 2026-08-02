export class CodexControlledSessionDisposalFence {
  private readonly disposals = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private readonly getLaunch: (conversationId: string) => Promise<unknown> | undefined,
    private readonly getConversationIds: () => Iterable<string>,
    private readonly disposeSession: (conversationId: string) => Promise<void>
  ) {}

  assertNotDisposing(conversationId: string): void {
    if (this.disposed || this.disposals.has(conversationId)) {
      throw new Error('controlled Codex session is disposing')
    }
  }

  async disposeConversation(conversationId: string): Promise<void> {
    const active = this.disposals.get(conversationId)
    if (active) {
      return active
    }
    const disposal = this.drainConversation(conversationId)
    this.disposals.set(conversationId, disposal)
    try {
      await disposal
    } finally {
      if (this.disposals.get(conversationId) === disposal) {
        this.disposals.delete(conversationId)
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled(
      [...new Set(this.getConversationIds())].map((id) => this.disposeConversation(id))
    )
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'controlled Codex session disposal failed')
    }
  }

  private async drainConversation(conversationId: string): Promise<void> {
    await this.getLaunch(conversationId)?.catch(() => {})
    await this.disposeSession(conversationId)
  }
}
