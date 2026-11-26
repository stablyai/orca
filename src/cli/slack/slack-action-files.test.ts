import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { localFile, uploadFile } from './slack-action-files'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PAGE = Buffer.from('<!doctype html><html><head><title>Report</title></head></html>')

let dir: string
let url: string
let close: (() => Promise<void>) | undefined
const received: { headers: IncomingHttpHeaders; body: Buffer }[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-slack-upload-'))
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks) })
      response.end('OK')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the upload server has no port')
  }
  url = `http://127.0.0.1:${address.port}/upload/v1/slot`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})

afterAll(async () => {
  await close?.()
  await rm(dir, { recursive: true, force: true })
})

async function upload(name: string, bytes: Buffer) {
  await writeFile(join(dir, name), bytes)
  received.length = 0
  await uploadFile(url, await localFile(dir, name))
  expect(received).toHaveLength(1)
  return received[0]
}

describe('uploadFile', () => {
  it.each(['report.html', 'REPORT.HTM'])('sends %s as text/html', async (name) => {
    const sent = await upload(name, PAGE)
    expect(sent.headers['content-type']).toBe('text/html')
    expect(sent.body.equals(PAGE)).toBe(true)
  })

  it.each([
    ['chart.png', PNG],
    ['dump.bin', PNG],
    ['notes.xyz', PAGE],
    ['page.html.txt', PAGE]
  ])('sends %s untyped, as before', async (name, bytes) => {
    const sent = await upload(name, bytes)
    expect(sent.headers['content-type']).toBeUndefined()
    expect(sent.body.equals(bytes)).toBe(true)
  })
})
