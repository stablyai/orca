import { createServer, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createPaperclipOriginPolicy } from './paperclip-origin-policy'
import { paperclipRequest } from './paperclip-request'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function serve(
  handler: RequestListener
): Promise<ReturnType<typeof createPaperclipOriginPolicy>> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address')
  }
  return createPaperclipOriginPolicy(`http://127.0.0.1:${address.port}`)
}

describe('Paperclip HTTP request bounds', () => {
  it('enforces an absolute deadline even while bytes keep arriving', async () => {
    const policy = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('[')
      const interval = setInterval(() => response.write(' '), 5)
      response.on('close', () => clearInterval(interval))
    })
    await expect(
      paperclipRequest({ policy, segments: ['issues'], deadlineMs: 40 })
    ).rejects.toThrow('timed out')
  })

  it('rejects redirects immediately without reading their body', async () => {
    const policy = await serve((_request, response) => {
      response.writeHead(302, { Location: 'http://127.0.0.1:9/escape' })
      response.write('never-ending')
    })
    await expect(
      paperclipRequest({ policy, segments: ['issues'], deadlineMs: 500 })
    ).rejects.toThrow('redirects are not allowed')
  })

  it('rejects responses larger than two MiB', async () => {
    const policy = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(Buffer.alloc(2 * 1024 * 1024 + 1, 32))
    })
    await expect(paperclipRequest({ policy, segments: ['issues'] })).rejects.toThrow('size limit')
  })
})
