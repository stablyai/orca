import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createCodexRolloutHistoryReferencesClient } from './codex-rollout-history-references-client'

class ExitingWorker extends EventEmitter {
  postMessage(): void {
    // A worker that dies mid-request answers nothing.
    queueMicrotask(() => this.emit('exit', 1))
  }

  async terminate(): Promise<number> {
    return 0
  }
}

it('proves nothing unreferenced once its worker died', async () => {
  const references = createCodexRolloutHistoryReferencesClient(
    new AbortController().signal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client uses only on/postMessage/terminate.
    () => new ExitingWorker() as unknown as Worker
  )

  await expect(references.refresh(['/home'])).rejects.toThrow('exited (1)')
  await expect(references.isReferenced('id')).rejects.toThrow('exited (1)')
  await references.close()
})
