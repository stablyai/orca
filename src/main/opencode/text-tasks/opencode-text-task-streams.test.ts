import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createOpenCodeTextTaskHttp } from './opencode-text-task-http'
import { openCodeTextTaskEvents } from './opencode-text-task-events'
import { readOpenCodeTextTaskServerUrl } from './opencode-text-task-server-ready'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fakeServer() {
  const child = new ChildProcess()
  Object.defineProperties(child, {
    stdout: { writable: true, configurable: true },
    stderr: { writable: true, configurable: true }
  })
  return Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() })
}

function eventStream(bytes: Buffer) {
  let offset = 0
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.subarray(offset, offset + 4096))
        offset += 4096
      }
    },
    cancel() {
      canceled = true
    }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options: RequestInit) => {
      const reader = stream.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const value = await reader.read()
          if (value.done) {
            controller.close()
          } else {
            controller.enqueue(value.value)
          }
        },
        async cancel() {
          await reader.cancel()
        }
      })
      options.signal?.addEventListener(
        'abort',
        () => {
          void reader.cancel()
        },
        { once: true }
      )
      return new Response(body)
    })
  )
  return () => canceled
}

it('rejects oversized streams and releases their reader; readiness also honors cancellation and size', async () => {
  const canceled = eventStream(Buffer.alloc(4 * 1024 * 1024 + 1, 65))
  const events = openCodeTextTaskEvents({
    version: 'v2',
    url: 'http://fixture',
    signal: new AbortController().signal,
    lost: new AbortController(),
    messageID: 'msg_input',
    context: () => ({
      sessionID: 'owned',
      owned: true,
      ownedTree: new Set(['owned']),
      directory: '/workspace',
      http: createOpenCodeTextTaskHttp('http://fixture', undefined, '/workspace')
    })
  })
  await events.subscribe()
  await expect(events.completion).rejects.toThrow('output limit')
  await events.close()
  expect(canceled()).toBe(true)
  const child = fakeServer()
  const ready = readOpenCodeTextTaskServerUrl(child, true, new AbortController().signal)
  child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1))
  await expect(ready).rejects.toThrow('output limit')
  const controller = new AbortController()
  const abort = readOpenCodeTextTaskServerUrl(fakeServer(), true, controller.signal)
  controller.abort(new Error('stopped'))
  await expect(abort).rejects.toThrow('stopped')
})
