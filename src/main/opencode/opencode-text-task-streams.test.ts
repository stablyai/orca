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

function framingWork() {
  const original = Buffer.prototype.indexOf
  const search = vi.spyOn(Buffer.prototype, 'indexOf')
  let searched = 0
  search.mockImplementation(function (this: Buffer, value, offset, encoding) {
    if (value === 10) {
      searched += this.length - (typeof offset === 'number' ? offset : 0)
    }
    return original.call(this, value, offset, encoding)
  })
  const accounting = vi.spyOn(Buffer, 'byteLength')
  const splitting = vi.spyOn(String.prototype, 'split')
  return () => ({
    searched:
      searched +
      splitting.mock.calls.reduce((sum, args, index) => {
        const separator: unknown = args[0]
        return sum + (separator === '\n' ? String(splitting.mock.contexts[index]).length : 0)
      }, 0),
    accounted: accounting.mock.calls.reduce(
      (sum, args) => sum + (typeof args[0] === 'string' ? args[0].length : args[0].byteLength),
      0
    )
  })
}

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

it('frames fragmented Unicode/CRLF events with linear search and accounting at N and 10N', async () => {
  for (const size of [128 * 1024, 1280 * 1024]) {
    const text = `${'a'.repeat(size)}🌊終`
    const bytes = Buffer.from(
      [
        {
          type: 'session.text.ended',
          data: { sessionID: 'owned', assistantMessageID: 'msg_output', ordinal: 0, text }
        },
        { type: 'session.execution.succeeded', data: { sessionID: 'owned' } }
      ]
        .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
        .join('')
    )
    const canceled = eventStream(bytes)
    const work = framingWork()
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
    await expect(events.completion).resolves.toBe(text)
    await events.close()
    // One forward newline scan plus bounded rescans within each 4 KiB transport chunk.
    expect(work().searched).toBeLessThanOrEqual(bytes.length + 4 * 4096)
    expect(work().accounted).toBeLessThanOrEqual(2 * bytes.length)
    expect(canceled()).toBe(true)
    vi.restoreAllMocks()
  }
})

it('reads a fragmented readiness line once at N and 10N and preserves Unicode boundaries', async () => {
  for (const size of [128 * 1024, 1280 * 1024]) {
    const child = fakeServer()
    const bytes = Buffer.from(
      `{"log":"${'a'.repeat(size)}🌊終"}\r\n{"url":"http://127.0.0.1:4096"}\r\n`
    )
    const work = framingWork()
    const ready = readOpenCodeTextTaskServerUrl(child, true, new AbortController().signal)
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      child.stdout.write(bytes.subarray(offset, offset + 4096))
    }
    await expect(ready).resolves.toBe('http://127.0.0.1:4096')
    expect(work().searched).toBeLessThanOrEqual(bytes.length + 4096)
    expect(work().accounted).toBe(0)
    child.stdout.destroy()
    child.stderr.destroy()
    vi.restoreAllMocks()
  }
})

it('accepts only native V1 readiness output and rejects malformed native addresses', async () => {
  const child = fakeServer()
  const ready = readOpenCodeTextTaskServerUrl(child, false, new AbortController().signal)
  child.stdout.write('MCP listening on http://localhost:undefined\n')
  child.stdout.write('dev server listening on http://localhost:3000\n')
  child.stdout.write('opencode server listening on http://127.0.0.1:4096\n')
  await expect(ready).resolves.toBe('http://127.0.0.1:4096')
  child.stdout.destroy()
  child.stderr.destroy()

  const malformed = fakeServer()
  const rejected = readOpenCodeTextTaskServerUrl(malformed, false, new AbortController().signal)
  expect(() => malformed.stdout.write('opencode server listening on http://[bad\n')).not.toThrow()
  await expect(rejected).rejects.toThrow('OpenCode private server returned an unexpected address')
  malformed.stdout.destroy()
  malformed.stderr.destroy()
})

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
