import { stat } from 'node:fs/promises'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'

export const AI_VAULT_WHOLE_JSON_MAX_BYTES = 64 * 1024 * 1024
export const AI_VAULT_JSON_READ_MAX_ACTIVE = 8
export const AI_VAULT_JSON_READ_MAX_WAITERS = 256
const WAIT_QUEUE_COMPACTION_HEAD = 64

type AdmissionWaiter = {
  bytes: number
  resolve: (release: () => void) => void
}

export class AiVaultJsonReadBudget {
  private retainedBytes = 0
  private activeReaders = 0
  private waiters: (AdmissionWaiter | undefined)[] = []
  private waiterHead = 0

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('AI Vault JSON read budget must be a non-negative safe integer')
    }
  }

  acquire(bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) {
      throw new RangeError(`AI Vault JSON document exceeds ${this.maxBytes} byte limit`)
    }
    if (this.waiters.length - this.waiterHead >= AI_VAULT_JSON_READ_MAX_WAITERS) {
      throw new Error('AI Vault JSON reader is busy; retry after active reads finish')
    }
    return new Promise((resolve) => {
      this.waiters.push({ bytes, resolve })
      this.admitWaiters()
    })
  }

  private admitWaiters(): void {
    while (this.waiterHead < this.waiters.length) {
      const waiter = this.waiters[this.waiterHead]!
      if (
        this.activeReaders >= AI_VAULT_JSON_READ_MAX_ACTIVE ||
        waiter.bytes > this.maxBytes - this.retainedBytes
      ) {
        return
      }
      this.waiters[this.waiterHead] = undefined
      this.waiterHead += 1
      if (this.waiterHead >= WAIT_QUEUE_COMPACTION_HEAD) {
        this.waiters.splice(0, this.waiterHead)
        this.waiterHead = 0
      }
      this.retainedBytes += waiter.bytes
      this.activeReaders += 1
      let released = false
      waiter.resolve(() => {
        if (released) {
          return
        }
        released = true
        this.retainedBytes -= waiter.bytes
        this.activeReaders -= 1
        this.admitWaiters()
      })
    }
    this.waiters.length = 0
    this.waiterHead = 0
  }
}

const jsonReadBudget = new AiVaultJsonReadBudget(AI_VAULT_WHOLE_JSON_MAX_BYTES)

export async function withAiVaultWholeJsonFile<T>(
  filePath: string,
  consume: (content: string) => T | Promise<T>
): Promise<T> {
  const fileStats = await stat(filePath)
  const release = await jsonReadBudget.acquire(fileStats.size)
  try {
    // Reject concurrent growth: the admission covers exactly the statted bytes.
    const { buffer } = await readNodeFileWithinLimit(filePath, fileStats.size)
    return await consume(buffer.toString('utf8'))
  } finally {
    release()
  }
}
