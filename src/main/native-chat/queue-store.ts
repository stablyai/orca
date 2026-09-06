import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  NativeChatQueuedMessage,
  NativeChatQueueSnapshot
} from '../../shared/native-chat-queue'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'

type PersistedQueues = { version: 1; queues: Record<string, NativeChatQueueSnapshot> }

export class NativeChatQueueStore {
  private readonly filePath: string
  private readonly queues: Record<string, NativeChatQueueSnapshot>

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'native-chat-queues.json')
    this.queues = Object.assign(Object.create(null), this.read())
    if (existsSync(this.filePath)) {
      writeDurableSecureJsonFile(this.filePath, { version: 1, queues: this.queues })
    }
  }

  snapshot(paneKey: string): NativeChatQueueSnapshot {
    return structuredClone(this.current(paneKey))
  }

  enqueue(
    paneKey: string,
    text: string,
    imagePaths: readonly string[],
    kind: NativeChatQueuedMessage['kind'],
    expectedRevision: number
  ): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    const prompt = text.trim()
    if (!prompt && !imagePaths.length) {
      throw new Error('conversation_prompt_empty')
    }
    return this.replace(paneKey, [
      ...queue.items,
      {
        id: randomUUID(),
        text: prompt,
        imagePaths: [...imagePaths],
        kind,
        createdAt: Date.now(),
        state: 'pending'
      }
    ])
  }

  edit(
    paneKey: string,
    messageId: string,
    text: string,
    imagePaths: readonly string[],
    kind: NativeChatQueuedMessage['kind'],
    expectedRevision: number
  ): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    const message = this.mutable(queue, messageId)
    const prompt = text.trim()
    if (!prompt && !imagePaths.length) {
      throw new Error('conversation_prompt_empty')
    }
    return this.replace(
      paneKey,
      queue.items.map((item) =>
        item.id === messageId
          ? {
              ...item,
              text: prompt,
              imagePaths: [...imagePaths],
              kind,
              state: 'pending',
              error: undefined
            }
          : item
      ),
      queue.items[0] === message && queue.paused === 'failed' ? undefined : queue.paused
    )
  }

  beginEdit(paneKey: string, messageId: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    this.mutable(queue, messageId)
    return this.replace(
      paneKey,
      queue.items.map((item) =>
        item.id === messageId ? { ...item, state: 'paused' as const, error: undefined } : item
      ),
      queue.paused
    )
  }

  remove(paneKey: string, messageId: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    const removed = this.mutable(queue, messageId)
    const items = queue.items.filter((item) => item.id !== messageId)
    return this.replace(
      paneKey,
      items,
      items.length === 0 || (removed.state === 'paused' && queue.paused === 'failed')
        ? undefined
        : queue.paused
    )
  }

  reorder(
    paneKey: string,
    messageIds: readonly string[],
    expectedRevision: number
  ): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    if (
      messageIds.length !== queue.items.length ||
      new Set(messageIds).size !== queue.items.length ||
      messageIds.some((id) => !queue.items.some((item) => item.id === id)) ||
      queue.items.some((item) => item.state === 'submitting')
    ) {
      throw new Error('conversation_queue_stale')
    }
    const byId = new Map(queue.items.map((item) => [item.id, item]))
    return this.replace(
      paneKey,
      messageIds.map((id) => byId.get(id)!)
    )
  }

  claim(paneKey: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    if (queue.paused || queue.items.some((item) => item.state === 'submitting')) {
      return this.snapshot(paneKey)
    }
    const head = queue.items[0]
    if (!head || head.state !== 'pending') {
      return this.snapshot(paneKey)
    }
    return this.replace(
      paneKey,
      queue.items.map((item) =>
        item.id === head.id ? { ...item, state: 'submitting' as const } : item
      )
    )
  }

  accept(paneKey: string, messageId: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    const message = queue.items.find((item) => item.id === messageId)
    if (message?.state !== 'submitting') {
      throw new Error('conversation_queue_stale')
    }
    return this.replace(
      paneKey,
      queue.items.filter((item) => item.id !== messageId)
    )
  }

  reject(
    paneKey: string,
    messageId: string,
    expectedRevision: number,
    uncertain: boolean,
    error: string
  ): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    const message = queue.items.find((item) => item.id === messageId)
    if (message?.state !== 'submitting') {
      throw new Error('conversation_queue_stale')
    }
    return this.replace(
      paneKey,
      queue.items.map((item) =>
        item.id === messageId
          ? { ...item, state: uncertain ? ('uncertain' as const) : ('paused' as const), error }
          : item
      ),
      uncertain ? queue.paused : 'failed'
    )
  }

  pause(paneKey: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    return queue.items.length ? this.replace(paneKey, queue.items, 'interrupted') : queue
  }

  resume(paneKey: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    if (queue.paused !== 'interrupted') {
      throw new Error('conversation_queue_not_interrupted')
    }
    return this.replace(paneKey, queue.items)
  }

  retry(paneKey: string, messageId: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.requireRevision(paneKey, expectedRevision)
    const head = queue.items[0]
    if (!head || head.id !== messageId || !['paused', 'uncertain'].includes(head.state)) {
      throw new Error('conversation_queue_stale')
    }
    return this.replace(
      paneKey,
      queue.items.map((item) =>
        item.id === messageId ? { ...item, state: 'pending' as const, error: undefined } : item
      )
    )
  }

  private current(paneKey: string): NativeChatQueueSnapshot {
    return Object.hasOwn(this.queues, paneKey)
      ? this.queues[paneKey]
      : { paneKey, revision: 0, items: [] }
  }

  private requireRevision(paneKey: string, expectedRevision: number): NativeChatQueueSnapshot {
    const queue = this.current(paneKey)
    if (queue.revision !== expectedRevision) {
      throw new Error('conversation_queue_stale')
    }
    return queue
  }

  private mutable(queue: NativeChatQueueSnapshot, messageId: string): NativeChatQueuedMessage {
    const message = queue.items.find((item) => item.id === messageId)
    if (!message) {
      throw new Error('conversation_queue_message_not_found')
    }
    if (message.state === 'submitting') {
      throw new Error('conversation_queue_message_busy')
    }
    return message
  }

  private replace(
    paneKey: string,
    items: NativeChatQueuedMessage[],
    paused?: NativeChatQueueSnapshot['paused']
  ): NativeChatQueueSnapshot {
    const next = { paneKey, revision: this.current(paneKey).revision + 1, items, paused }
    this.queues[paneKey] = next
    writeDurableSecureJsonFile(this.filePath, { version: 1, queues: this.queues })
    return structuredClone(next)
  }

  private read(): Record<string, NativeChatQueueSnapshot> {
    if (!existsSync(this.filePath)) {
      return {}
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedQueues
      if (parsed.version !== 1 || !parsed.queues || typeof parsed.queues !== 'object') {
        return {}
      }
      for (const queue of Object.values(parsed.queues)) {
        queue.items = queue.items.map((item) =>
          item.state === 'submitting'
            ? { ...item, state: 'uncertain', error: 'conversation_send_uncertain' }
            : item
        )
      }
      return parsed.queues
    } catch {
      return {}
    }
  }
}
