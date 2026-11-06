import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { runLegacyTranscriptImportWorker } from './journal-legacy-import-worker'
import type { LegacyTranscriptImportRequest } from './journal-legacy-import-worker-protocol'

const request: LegacyTranscriptImportRequest = {
  agent: 'claude',
  transcriptAgent: 'claude',
  sessionId: 'session',
  filePath: '/source.jsonl',
  limits: { inlineHeadBytes: 16384 },
  validateSource: true
}
const observed = { sessionId: 'session', cwd: '/workspace' }
const result = { ok: true, items: [], sourceEmpty: false }

class TestWorker extends EventEmitter {
  reply: (value: unknown) => void = () => {}
  unref(): void {}
  postMessage(value: unknown): void {
    this.reply(value)
  }
  terminate(): Promise<number> {
    queueMicrotask(() => this.emit('exit', 1))
    return Promise.resolve(1)
  }
}

it('keeps validation on the host and publishes only after successful exit', async () => {
  const worker = new TestWorker()
  let acknowledge: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  let validated: (() => void) | undefined
  const validation = new Promise<void>((resolve) => {
    validated = resolve
  })
  worker.reply = (reply) => {
    expect(reply).toEqual({ ok: true })
    worker.emit('message', { type: 'result', result })
    acknowledge()
  }
  const pending = runLegacyTranscriptImportWorker(
    request,
    async (actual) => {
      expect(actual).toEqual(observed)
      await validation
    },
    undefined,
    () => worker
  )
  worker.emit('message', { type: 'validate-source', observed })
  validated?.()
  await ready
  worker.emit('exit', 0)
  await expect(pending).resolves.toEqual(result)
})

it('cancels the host probe and joins the worker when adoption aborts during validation', async () => {
  const worker = new TestWorker()
  const abort = new AbortController()
  let validationSignal: AbortSignal | undefined
  let started: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = runLegacyTranscriptImportWorker(
    request,
    async (_actual, signal) => {
      validationSignal = signal
      started()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    },
    abort.signal,
    () => worker
  )
  const assertion = expect(pending).rejects.toThrow('closed conversation')
  worker.emit('message', { type: 'validate-source', observed })
  await ready
  abort.abort(new Error('closed conversation'))
  await assertion
  expect(validationSignal?.aborted).toBe(true)
})

it.each(['nonzero', 'missing', 'unvalidated', 'duplicate'] as const)(
  'rejects %s worker completion without publishing',
  async (kind) => {
    const worker = new TestWorker()
    const pending = runLegacyTranscriptImportWorker(
      { ...request, validateSource: kind === 'unvalidated' },
      async () => {},
      undefined,
      () => worker
    )
    const assertion = expect(pending).rejects.toBeInstanceOf(Error)
    if (kind !== 'missing') {
      worker.emit('message', { type: 'result', result })
    }
    if (kind === 'duplicate') {
      worker.emit('message', { type: 'result', result })
    } else {
      worker.emit('exit', kind === 'nonzero' ? 1 : 0)
    }
    await assertion
  }
)
