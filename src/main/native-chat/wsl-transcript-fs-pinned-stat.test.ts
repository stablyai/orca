import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { WslTranscriptFsProcessClient } from './wsl-transcript-fs-process-client'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'

class TranscriptProcess extends EventEmitter {
  readonly sent: WslTranscriptFsProcessRequest[] = []
  readonly channel = { unref: () => {} }

  kill(): boolean {
    return true
  }

  unref(): void {}

  send(message: WslTranscriptFsProcessRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  respond(response: WslTranscriptFsProcessResponse): void {
    this.emit('message', response)
  }
}

it('preserves pinned bigint identity and rejects stat after handle close', async () => {
  const child = new TranscriptProcess()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fake implements the event, IPC, and lifecycle operations consumed by the client.
  const client = new WslTranscriptFsProcessClient(() => child as unknown as ChildProcess)
  const signal = new AbortController().signal
  try {
    const opening = client.open(String.raw`\\wsl.localhost\Ubuntu\file`, signal)
    child.respond({ id: child.sent[0]!.id, ok: true, value: 17 })
    const handle = await opening
    const pending = client.stat(handle, signal)
    expect(child.sent[1]).toMatchObject({ operation: 'fstatBigInt', handleId: 17 })
    child.respond({
      id: child.sent[1]!.id,
      ok: true,
      value: { dev: 1n, ino: 9007199254740993n, size: 16n, mtimeNs: 10n, ctimeNs: 11n }
    })
    await expect(pending).resolves.toEqual({
      dev: 1n,
      ino: 9007199254740993n,
      size: 16n,
      mtimeNs: 10n,
      ctimeNs: 11n
    })
    const closing = client.close(handle)
    child.respond({ id: child.sent[2]!.id, ok: true, value: true })
    await closing
    await expect(client.stat(handle, signal)).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    client.dispose()
  }
})
