import type { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runCodexAppServerSession } from './codex-app-server-session'

describe('runCodexAppServerSession fragmented output', () => {
  it('parses a response delivered as 100,000 one-byte fragments', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true) as ChildProcess['kill']
    child.stdin.on('data', (bytes: Buffer) => {
      const request = JSON.parse(bytes.toString()) as { id?: number; method: string }
      if (request.id === undefined) {
        return
      }
      const response = Buffer.from(
        `${request.method === 'fragment/get' ? ' '.repeat(99_950) : ''}${JSON.stringify({
          id: request.id,
          result: request.method === 'fragment/get' ? { value: 'complete' } : {}
        })}\n`
      )
      for (let index = 0; index < response.byteLength; index += 1) {
        child.stdout.emit('data', response.subarray(index, index + 1))
      }
    })
    child.stdin.once('finish', () => {
      queueMicrotask(() => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
    })
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn

    const result = await runCodexAppServerSession(
      { command: 'codex', args: ['app-server'], timeoutMs: 5_000 },
      ({ request }) => request('fragment/get'),
      spawnImpl
    )

    expect(result).toEqual({ value: 'complete' })
  })
})
