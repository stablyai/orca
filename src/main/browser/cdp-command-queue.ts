export const CDP_MAX_QUEUED_COMMANDS_PER_TAB = 64
export const CDP_MAX_QUEUED_COMMANDS_TOTAL = 512

type QueuedCdpCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export class CdpCommandQueue {
  private readonly queues = new Map<string, QueuedCdpCommand[]>()
  private readonly processing = new Set<string>()
  private queuedCount = 0

  constructor(
    private readonly createOverflowError: () => Error,
    private readonly maxQueuedPerTab = CDP_MAX_QUEUED_COMMANDS_PER_TAB,
    private readonly maxQueuedTotal = CDP_MAX_QUEUED_COMMANDS_TOTAL
  ) {}

  enqueue<T>(tabId: string, execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let queue = this.queues.get(tabId)
      if ((queue?.length ?? 0) >= this.maxQueuedPerTab || this.queuedCount >= this.maxQueuedTotal) {
        reject(this.createOverflowError())
        return
      }
      if (!queue) {
        queue = []
        this.queues.set(tabId, queue)
      }
      queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.queuedCount += 1
      void this.process(tabId)
    })
  }

  closeTab(tabId: string, error: Error): void {
    const queue = this.queues.get(tabId)
    if (!queue) {
      return
    }
    this.queues.delete(tabId)
    for (const command of queue.splice(0)) {
      this.queuedCount = Math.max(0, this.queuedCount - 1)
      command.reject(error)
    }
  }

  private async process(tabId: string): Promise<void> {
    if (this.processing.has(tabId)) {
      return
    }
    this.processing.add(tabId)
    const queue = this.queues.get(tabId)
    try {
      while (queue && queue.length > 0) {
        const command = queue.shift()!
        this.queuedCount = Math.max(0, this.queuedCount - 1)
        try {
          command.resolve(await command.execute())
        } catch (error) {
          command.reject(error)
        }
      }
      if (this.queues.get(tabId) === queue) {
        this.queues.delete(tabId)
      }
    } finally {
      this.processing.delete(tabId)
      if ((this.queues.get(tabId)?.length ?? 0) > 0) {
        void this.process(tabId)
      }
    }
  }
}
