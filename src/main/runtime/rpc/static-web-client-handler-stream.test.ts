import { once } from 'node:events'
import type * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

const observed = vi.hoisted(() => {
  const streams: ReadStream[] = []
  const state: {
    statWait: Promise<void>
    statError?: Error
    missingPath?: string
    onSource?: () => void
  } = {
    statWait: Promise.resolve()
  }
  return { streams, state, statCalls: 0, completedStats: 0 }
})
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return {
    ...original,
    createReadStream: (...args: Parameters<typeof original.createReadStream>) => {
      const stream = original.createReadStream(observed.state.missingPath ?? args[0], args[1])
      observed.streams.push(stream)
      observed.state.onSource?.()
      return stream
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>()
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      observed.statCalls++
      const value = await original.stat(...args)
      await observed.state.statWait
      observed.completedStats++
      if (observed.state.statError) {
        throw observed.state.statError
      }
      return value
    }
  }
})

let root: string
const servers: Server[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-static-web-stream-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'fixture.js'), Buffer.alloc(1024 * 1024, 1))
  writeFileSync(join(root, 'web-index.html'), '<html>web</html>')
  observed.state.statWait = Promise.resolve()
  observed.state.statError = undefined
  observed.state.missingPath = undefined
  observed.state.onSource = undefined
  observed.statCalls = 0
  observed.completedStats = 0
})
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
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
async function startServer(): Promise<string> {
  const server = createServer(createStaticWebClientHandler(root))
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing HTTP address')
  }
  return `http://127.0.0.1:${address.port}`
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

it('does not stat or open assets for an already closed response', async () => {
  const response = fakeResponse()
  const closed = once(response, 'close')
  response.destroy()
  await closed
  request(response)
  expect(observed.statCalls).toBe(0)
  expect(observed.streams).toHaveLength(0)
  expect(response.setHeader).not.toHaveBeenCalled()
})

it.each(['success', 'failure'])(
  'does not revive a response closed during stat %s',
  async (outcome) => {
    let releaseStat = (): void => {}
    observed.state.statWait = new Promise<void>((resolve) => {
      releaseStat = resolve
    })
    if (outcome === 'failure') {
      observed.state.statError = new Error('stat failed after abandonment')
    }
    const response = request()
    expect(observed.statCalls).toBe(1)
    const ended = vi.spyOn(response, 'end')
    const closed = once(response, 'close')
    response.destroy()
    await closed
    releaseStat()
    await expect.poll(() => observed.completedStats).toBe(1)
    expect(observed.streams).toHaveLength(0)
    expect(response.setHeader).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
  }
)

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

it('closes its file reader when the response errors', async () => {
  const response = request()
  const source = await latestSource(1)
  await expect.poll(() => source.isPaused()).toBe(true)
  response.destroy(new Error('downstream failed'))
  await expect.poll(() => source.closed).toBe(true)
  expect(fileDescriptor(source)).toBe(null)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})

it('disconnects a response when its source fails after headers', async () => {
  const response = request()
  const source = await latestSource(1)
  response.headersSent = true
  const closed = once(response, 'close')
  source.destroy(new Error('read failed after headers'))
  await closed
  await expect.poll(() => source.closed).toBe(true)
  expect(response.statusCode).toBe(200)
  expect(response.destroyed).toBe(true)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})

it('preserves actual HTTP GET bytes, cache headers and HEAD without a reader', async () => {
  const url = await startServer()
  const head = await fetch(`${url}/assets/fixture.js`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe(String(1024 * 1024))
  expect(await head.text()).toBe('')
  expect(observed.streams).toHaveLength(0)
  const get = await fetch(`${url}/assets/fixture.js`)
  expect(get.status).toBe(200)
  expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(get.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(Buffer.from(await get.arrayBuffer())).toEqual(Buffer.alloc(1024 * 1024, 1))
  await expect.poll(() => observed.streams.every((source) => source.closed)).toBe(true)
  const index = await fetch(`${url}/`)
  expect(index.headers.get('cache-control')).toBe('no-cache')
  expect(await index.text()).toBe('<html>web</html>')
})

it('answers an actual file-open error with an empty 500 instead of the asset length', async () => {
  observed.state.missingPath = join(root, 'missing-after-stat.js')
  const url = await startServer()
  const response = await fetch(`${url}/assets/fixture.js`)
  expect(response.status).toBe(500)
  expect(response.headers.get('content-length')).toBe('0')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.text()).toBe('')
  await expect.poll(() => observed.streams.every((source) => source.closed)).toBe(true)
})
