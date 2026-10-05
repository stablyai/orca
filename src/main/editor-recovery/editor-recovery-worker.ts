import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import {
  editorRecoveryResponseSchema,
  type EditorRecoveryCommand
} from './editor-recovery-protocol'
import {
  EDITOR_RECOVERY_BATCH_RECORD_LIMIT,
  EDITOR_RECOVERY_BATCH_TEXT_BYTES,
  editorRecoveryAckSchema,
  editorRecoveryDraftSchema,
  editorRecoveryEntrySchema,
  editorRecoveryStatusSchema,
  type EditorRecoveryChange,
  type EditorRecoveryMetadata
} from '../../shared/editor-recovery'

export function resolveEditorRecoveryWorkerPath(moduleDir = __dirname): string {
  const entry = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(moduleDir),
    'editor-recovery-worker-entry.js'
  )
  return (
    [entry, join(dirname(entry), '..', 'editor-recovery-worker-entry.js')].find(existsSync) ?? entry
  )
}

export class EditorRecoveryWorker {
  private worker: Worker | null = null
  private closing: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private nextRequestId = 1
  private failed: Error | null = null
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(
    private readonly databasePath: string,
    private readonly workerPath = resolveEditorRecoveryWorkerPath(),
    private readonly timeoutMs = 15_000,
    private readonly idleMs = 1_000
  ) {}

  private startWorker(): Worker {
    const worker = new Worker(this.workerPath, { workerData: { databasePath: this.databasePath } })
    this.worker = worker
    worker.unref()
    worker.on('message', (message: unknown) => {
      if (this.worker !== worker) {
        return
      }
      const parsed = editorRecoveryResponseSchema.safeParse(message)
      if (!parsed.success) {
        this.fail(new Error('Invalid recovery writer response'))
        return
      }
      const response = parsed.data
      const request = this.pending.get(response.requestId)
      if (!request) {
        this.fail(new Error('Unexpected recovery writer acknowledgement'))
        return
      }
      this.pending.delete(response.requestId)
      clearTimeout(request.timer)
      if (response.ok) {
        request.resolve(response.result)
      } else {
        request.reject(new Error(response.error))
      }
      this.scheduleIdleClose()
    })
    worker.on('error', (error: unknown) => {
      if (this.worker === worker) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.fail(new Error('Recovery writer stopped'))
      }
    })
    return worker
  }
  get isRunning(): boolean {
    return this.failed === null && !this.closed
  }

  async list() {
    return z.array(editorRecoveryEntrySchema).parse(await this.dispatch({ kind: 'list' }))
  }
  async read(id: string) {
    return editorRecoveryDraftSchema.nullable().parse(await this.dispatch({ kind: 'read', id }))
  }
  async status(ids: string[]) {
    return z.array(editorRecoveryStatusSchema).parse(await this.dispatch({ kind: 'status', ids }))
  }
  async apply(changes: EditorRecoveryChange[]) {
    const acknowledgements = z
      .array(editorRecoveryAckSchema)
      .parse(await this.dispatch({ kind: 'apply', changes }))
    if (
      acknowledgements.length !== changes.length ||
      acknowledgements.some(
        (ack, index) =>
          ack.id !== changes[index]?.id ||
          (ack.revision !== null && ack.revision !== (changes[index]?.expectedRevision ?? 0) + 1)
      )
    ) {
      this.fail(new Error('Invalid recovery commit acknowledgement'))
      throw this.failed
    }
    return acknowledgements
  }
  async importLegacy(drafts: { metadata: EditorRecoveryMetadata; content: string }[]) {
    let batch: typeof drafts = []
    let textBytes = 0
    for (const draft of drafts) {
      const draftBytes = draft.content.length * 2
      if (
        batch.length > 0 &&
        (batch.length === EDITOR_RECOVERY_BATCH_RECORD_LIMIT ||
          textBytes + draftBytes > EDITOR_RECOVERY_BATCH_TEXT_BYTES)
      ) {
        await this.dispatch({ kind: 'import', drafts: batch })
        batch = []
        textBytes = 0
      }
      batch.push(draft)
      textBytes += draftBytes
    }
    await this.dispatch({ kind: 'import', drafts: batch })
  }
  async restore(resources: EditorRecoveryMetadata[], checkpointIds: string[]) {
    return z
      .object({
        drafts: z.array(editorRecoveryDraftSchema.nullable()),
        resolvedIds: z.array(z.string())
      })
      .parse(await this.dispatch({ kind: 'restore', resources, checkpointIds }))
  }
  async export(id: string, revision: number, targetPath: string) {
    return z.string().parse(await this.dispatch({ kind: 'export', id, revision, targetPath }))
  }
  async close() {
    this.closed = true
    this.cancelIdleClose()
    if (this.failed) {
      return
    }
    await this.stopWorker()
  }

  private async dispatch(command: EditorRecoveryCommand): Promise<unknown> {
    this.cancelIdleClose()
    if (this.closing) {
      await this.closing
    }
    if (this.failed) {
      throw this.failed
    }
    if (this.closed) {
      throw new Error('Recovery writer is closed')
    }
    return this.send(command, this.worker ?? this.startWorker())
  }

  private send(command: EditorRecoveryCommand, worker: Worker): Promise<unknown> {
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error('Recovery writer did not acknowledge the checkpoint')),
        this.timeoutMs
      )
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        worker.postMessage({ requestId, command })
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private scheduleIdleClose(): void {
    if (this.closed || this.closing || this.failed || this.pending.size > 0) {
      return
    }
    this.cancelIdleClose()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.stopWorker().catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
    }, this.idleMs)
    this.idleTimer.unref()
  }

  private cancelIdleClose(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private stopWorker(): Promise<void> {
    if (this.closing) {
      return this.closing
    }
    const worker = this.worker
    if (!worker) {
      return Promise.resolve()
    }
    this.cancelIdleClose()
    this.closing = this.send({ kind: 'close' }, worker)
      .then(async () => {
        if (this.worker === worker) {
          this.worker = null
        }
        await worker.terminate()
      })
      .finally(() => {
        this.closing = null
      })
    return this.closing
  }

  private fail(error: Error): void {
    this.cancelIdleClose()
    this.failed ??= error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(this.failed)
    }
    this.pending.clear()
    void this.worker?.terminate()
    this.worker = null
  }
}
