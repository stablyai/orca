import { once } from 'node:events'
import type * as fs from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, type ReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Connect, ViteDevServer } from 'vite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPdfjsViewerAssetsPlugin } from '../build-plugins/pdfjs-viewer-assets'

const observed = vi.hoisted(() => {
  const streams: ReadStream[] = []
  return { streams }
})
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return {
    ...original,
    createReadStream: (...args: Parameters<typeof original.createReadStream>) => {
      const stream = original.createReadStream(...args)
      observed.streams.push(stream)
      return stream
    }
  }
})

let root: string
let middleware: Connect.NextHandleFunction

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-pdfjs-stream-'))
  mkdirSync(join(root, 'wasm'))
  mkdirSync(join(root, 'cmaps'))
  writeFileSync(join(root, 'wasm', 'fixture.wasm'), Buffer.alloc(1024 * 1024, 1))
  writeFileSync(join(root, 'cmaps', 'fixture.bcmap'), 'map bytes')
  const hook = createPdfjsViewerAssetsPlugin(root).configureServer
  if (typeof hook !== 'function') {
    throw new Error('Missing configureServer hook')
  }
  const server = {
    middlewares: {
      use(handler: Connect.NextHandleFunction) {
        middleware = handler
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook only registers middleware through the supplied use method.
  hook.call({} as never, server as ViteDevServer)
})

afterEach(async () => {
  await Promise.all(
    observed.streams.map(async (stream) => {
      if (stream.closed) {
        return
      }
      const closed = new Promise<void>((resolve) => stream.once('close', resolve))
      stream.destroy()
      await closed
    })
  )
  observed.streams.length = 0
  rmSync(root, { recursive: true, force: true })
})

function request(method = 'GET', url = '/wasm/fixture.wasm') {
  const response = Object.assign(new PassThrough({ highWaterMark: 16 }), {
    setHeader: vi.fn(),
    statusCode: 0
  })
  const next = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The middleware reads only method/url and uses the implemented writable response and header fields.
  middleware({ method, url } as IncomingMessage, response as unknown as ServerResponse, next)
  return { response, next, source: observed.streams.at(-1) }
}

it('releases file handles after repeated abandoned responses with backpressure', async () => {
  const responses: PassThrough[] = []
  for (let index = 0; index < 25; index += 1) {
    const { response, source } = request()
    responses.push(response)
    if (!source) {
      throw new Error('Missing source')
    }
    await once(source, 'pause')
    const closed = once(response, 'close')
    response.destroy()
    await closed
  }
  await expect.poll(() => observed.streams.filter((stream) => !stream.closed).length).toBe(0)
  expect(observed.streams.every((stream) => stream.fd === null)).toBe(true)
  expect(responses.map((response) => response.listenerCount('close'))).toEqual(Array(25).fill(0))
  expect(responses.map((response) => response.listenerCount('error'))).toEqual(Array(25).fill(0))
})

it('preserves successful GET bytes and removes response cleanup listeners', async () => {
  const { response, source, next } = request('GET', '/cmaps/fixture.bcmap')
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer) => chunks.push(chunk))
  await once(response, 'end')
  await expect.poll(() => source?.closed).toBe(true)
  expect(Buffer.concat(chunks).toString()).toBe('map bytes')
  expect(response.statusCode).toBe(200)
  expect(response.setHeader.mock.calls).toEqual([
    ['Content-Length', 9],
    ['Content-Type', 'application/octet-stream']
  ])
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
  expect(next).not.toHaveBeenCalled()
})

it('answers HEAD without opening a file stream', () => {
  const { response, next } = request('HEAD')
  expect(observed.streams).toHaveLength(0)
  expect(response.writableEnded).toBe(true)
  expect(response.setHeader.mock.calls).toEqual([
    ['Content-Length', 1024 * 1024],
    ['Content-Type', 'application/wasm']
  ])
  expect(next).not.toHaveBeenCalled()
  response.destroy()
})

it('closes the response on source failure without leaving listeners', async () => {
  const { response, source } = request()
  if (!source) {
    throw new Error('Missing source')
  }
  const closed = once(response, 'close')
  source.destroy(new Error('fixture read failed'))
  await closed
  await expect.poll(() => source.closed).toBe(true)
  expect(response.destroyed).toBe(true)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})

it('closes a source when the response fails', async () => {
  const { response, source } = request()
  if (!source) {
    throw new Error('Missing source')
  }
  await once(source, 'pause')
  response.destroy(new Error('fixture downstream failed'))
  await expect.poll(() => source.closed).toBe(true)
  expect(source.fd).toBe(null)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})

it.each([
  ['POST', '/wasm/fixture.wasm'],
  ['GET', '/wasm/missing.wasm'],
  ['GET', '/other/fixture.wasm'],
  ['GET', '/wasm/%00.wasm']
])('passes through %s %s without a stream', (method, url) => {
  const { response, next } = request(method, url)
  expect(observed.streams).toHaveLength(0)
  expect(next).toHaveBeenCalledOnce()
  response.destroy()
})

it('does not open a stream when earlier middleware resumes after response close', async () => {
  const response = Object.assign(new PassThrough(), { setHeader: vi.fn(), statusCode: 0 })
  const closed = once(response, 'close')
  response.destroy()
  await closed
  middleware(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The middleware reads only these method/url fields.
    { method: 'GET', url: '/wasm/fixture.wasm' } as IncomingMessage,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the writable response and header fields used by this middleware.
    response as unknown as ServerResponse,
    vi.fn()
  )
  expect(observed.streams).toHaveLength(0)
})
