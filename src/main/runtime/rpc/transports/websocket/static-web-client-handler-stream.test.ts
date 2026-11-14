import { once } from 'node:events'
import type * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

const observed = vi.hoisted(() => {
  const streams: ReadStream[] = []
  const state: {
    onSource?: () => void
  } = {}
  return { streams, state }
})
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return {
    ...original,
    createReadStream: (...args: Parameters<typeof original.createReadStream>) => {
      const stream = original.createReadStream(args[0], args[1])
      observed.streams.push(stream)
      observed.state.onSource?.()
      return stream
    }
  }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-static-web-stream-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'fixture.js'), Buffer.alloc(1024 * 1024, 1))
  writeFileSync(join(root, 'web-index.html'), '<html>web</html>')
  observed.state.onSource = undefined
})
afterEach(async () => {
  await Promise.all(
    observed.streams.splice(0).map(async (stream) => {
      if (!stream.closed) {
        const closed = new Promise<void>((resolve) => stream.once('close', resolve))
        stream.destroy()
        await closed
      }
    })
  )
  rmSync(root, { recursive: true, force: true })
})

function fakeResponse() {
  return Object.assign(new PassThrough({ highWaterMark: 16 }), {
    setHeader: vi.fn(),
    statusCode: 0,
    headersSent: false
  })
}
function fileDescriptor(stream: ReadStream): number | null {
  if ('fd' in stream && (typeof stream.fd === 'number' || stream.fd === null)) {
    return stream.fd
  }
  throw new Error('Missing file descriptor')
}
function request(response = fakeResponse()) {
  const handler = createStaticWebClientHandler(root)
  handler(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler reads only these method/url fields.
    { method: 'GET', url: '/assets/fixture.js' } as IncomingMessage,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the writable response surface used by this handler.
    response as unknown as ServerResponse
  )
  return response
}
async function latestSource(count: number): Promise<ReadStream> {
  await expect.poll(() => observed.streams.length).toBe(count)
  const source = observed.streams.at(-1)
  if (!source) {
    throw new Error('Missing file stream')
  }
  return source
}

it('closes 25 abandoned file readers and removes only owned response listeners', async () => {
  const responses: ReturnType<typeof fakeResponse>[] = []
  const otherClose = vi.fn()
  const otherError = vi.fn()
  for (let index = 0; index < 25; index++) {
    const response = fakeResponse()
    response.on('close', otherClose)
    response.on('error', otherError)
    request(response)
    responses.push(response)
    const source = await latestSource(index + 1)
    await expect.poll(() => source.isPaused()).toBe(true)
    const closed = once(response, 'close')
    response.destroy()
    await closed
  }
  await expect.poll(() => observed.streams.filter((stream) => !stream.closed).length).toBe(0)
  expect(observed.streams.every((stream) => fileDescriptor(stream) === null)).toBe(true)
  expect(responses.every((response) => response.listeners('close').length === 1)).toBe(true)
  expect(responses.every((response) => response.listeners('error').length === 1)).toBe(true)
  expect(otherClose).toHaveBeenCalledTimes(25)
  expect(otherError).not.toHaveBeenCalled()
})

it('closes a file that is still opening when its response is destroyed', async () => {
  const response = fakeResponse()
  observed.state.onSource = () => {
    const source = observed.streams.at(-1)
    expect(source && fileDescriptor(source)).toBe(null)
    response.destroy()
  }
  request(response)
  const source = await latestSource(1)
  await expect.poll(() => source.closed).toBe(true)
  expect(fileDescriptor(source)).toBe(null)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})
