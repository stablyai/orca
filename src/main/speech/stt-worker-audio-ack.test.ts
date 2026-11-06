import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

type WorkerTestMessage =
  | { type: 'feed'; samples: Float32Array; sampleRate: number; byteEnd: number; frameEnd: number }
  | {
      type: 'init'
      modelDir: string
      modelType: string
      streaming: boolean
      sampleRate: number
      files: string[]
    }
  | { type: 'stop' }

function untilMessage(
  worker: Worker,
  message: WorkerTestMessage,
  finalType: string
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = []
    const cleanup = (): void => {
      clearTimeout(timer)
      worker.off('message', accept)
      worker.off('error', fail)
      worker.off('exit', exited)
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const exited = (): void => fail(new Error('Worker exited before expected message'))
    const accept = (event: unknown): void => {
      events.push(event)
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === finalType
      ) {
        cleanup()
        resolve(events)
      }
    }
    const timer = setTimeout(() => fail(new Error('Timed out waiting for speech worker')), 5000)
    worker.on('message', accept)
    worker.on('error', fail)
    worker.on('exit', exited)
    try {
      worker.postMessage(message)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

it('acknowledges actual worker consumption on success, native error and early return', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-stt-audio-ack-'))
  let worker: Worker | undefined
  try {
    const workerPath = join(directory, 'worker.cjs')
    const nativePath = join(directory, 'recognizer.cjs')
    await build({
      entryPoints: [join(import.meta.dirname, 'stt-worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    await writeFile(
      nativePath,
      `
exports.createOnlineRecognizer = () => ({});
exports.createOnlineStream = () => ({});
exports.acceptWaveformOnline = (_stream, input) => { if (input.samples[0] < 0) throw new Error('controlled decode failure'); };
exports.isOnlineStreamReady = () => false;
exports.getOnlineStreamResultAsJson = () => '{}';
exports.isEndpoint = () => false;
exports.inputFinished = () => {};
`
    )
    worker = new Worker(workerPath, { workerData: { sherpaModulePath: nativePath } })
    const feed = (value: number, end: number): WorkerTestMessage => ({
      type: 'feed',
      samples: new Float32Array([value]),
      sampleRate: 16000,
      byteEnd: end * 4,
      frameEnd: end
    })
    expect(await untilMessage(worker, feed(1, 1), 'audio-consumed')).toEqual([
      { type: 'audio-consumed', byteEnd: 4, frameEnd: 1 }
    ])
    expect(
      await untilMessage(
        worker,
        {
          type: 'init',
          modelDir: directory,
          modelType: 'transducer',
          streaming: true,
          sampleRate: 16000,
          files: ['tokens.txt', 'encoder.onnx', 'decoder.onnx', 'joiner.onnx']
        },
        'ready'
      )
    ).toEqual([{ type: 'ready' }])
    expect(await untilMessage(worker, feed(1, 2), 'audio-consumed')).toEqual([
      { type: 'audio-consumed', byteEnd: 8, frameEnd: 2 }
    ])
    expect(await untilMessage(worker, feed(-1, 3), 'audio-consumed')).toEqual([
      { type: 'error', error: 'Error: controlled decode failure' },
      { type: 'audio-consumed', byteEnd: 12, frameEnd: 3 }
    ])
    expect(await untilMessage(worker, { type: 'stop' }, 'stopped')).toEqual([{ type: 'stopped' }])
  } finally {
    await worker?.terminate()
    await rm(directory, { recursive: true, force: true })
  }
})
