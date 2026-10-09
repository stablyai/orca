import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readDocPreviewFile: vi.fn() }))
vi.mock('electron', () => ({ protocol: {}, session: {} }))
vi.mock('./doc-preview-file-reader', () => ({ readDocPreviewFile: mocks.readDocPreviewFile }))
vi.mock('./browser-session-partition-policies', () => ({
  installBrowserSessionPartitionPolicies: vi.fn()
}))

import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { setDocPreviewFailureSink } from './doc-preview-failure-notice'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'
import { handleDocPreviewRequest } from './doc-preview-protocol'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function serve(bytes: Buffer, contentType = 'text/html; charset=utf-8'): Promise<Response> {
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
  mocks.readDocPreviewFile.mockResolvedValueOnce({ ok: true, bytes, contentType })
  return handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'index.html')))
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
  setDocPreviewFailureSink(null)
})

afterEach(() => {
  revokeAllDocPreviewGrants()
})

describe('document preview response allocation', () => {
  it('serves existing PNG assets without a full intermediate body copy', async () => {
    const fixtures = ['mobile/assets/icon.png', 'resources/app-icons/orca-watercolor.png'].map(
      (path) => {
        const bytes = readFileSync(resolve(path))
        return { bytes, expectedDigest: digest(bytes), expectedLength: bytes.byteLength }
      }
    )
    const nativeUint8Array = globalThis.Uint8Array
    let intermediateCopyBytes = 0
    globalThis.Uint8Array = new Proxy(nativeUint8Array, {
      construct(target, argumentsList, newTarget) {
        const source: unknown = argumentsList[0]
        const bytes: unknown = Reflect.construct(target, argumentsList, newTarget)
        if (!(bytes instanceof nativeUint8Array)) {
          throw new Error('Unexpected byte constructor result')
        }
        if (Buffer.isBuffer(source) && fixtures.some((fixture) => fixture.bytes === source)) {
          intermediateCopyBytes += bytes.byteLength
        }
        return bytes
      }
    })
    try {
      for (const fixture of fixtures) {
        const response = await serve(fixture.bytes, 'image/png')
        fixture.bytes.fill(0)
        const clone = response.clone()
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('image/png')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        for (const body of [response, clone]) {
          const bytes = Buffer.from(await body.arrayBuffer())
          expect(bytes.byteLength).toBe(fixture.expectedLength)
          expect(digest(bytes)).toBe(fixture.expectedDigest)
        }
      }
      expect(intermediateCopyBytes).toBe(0)
    } finally {
      globalThis.Uint8Array = nativeUint8Array
    }
  })

  it('keeps only the requested range and snapshots pooled, offset, shared and cross-realm bytes', async () => {
    const payload = Buffer.from('<p>π😀\u0000 independent bytes</p>', 'utf8')
    const expectedDigest = digest(payload)
    const pooled = Buffer.from(payload)
    expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength)

    const backing = new ArrayBuffer(payload.byteLength + 4096)
    new Uint8Array(backing).fill(0xa5)
    const offset = Buffer.from(backing, 127, payload.byteLength)
    offset.set(payload)
    expect(offset.byteOffset).toBe(127)

    const sharedBacking = new SharedArrayBuffer(payload.byteLength + 4096)
    const shared = Buffer.from(sharedBacking, 127, payload.byteLength)
    shared.set(payload)

    const foreignBacking: unknown = runInNewContext('new ArrayBuffer(4096)')
    if (!types.isAnyArrayBuffer(foreignBacking)) {
      throw new Error('Expected a cross-realm byte backing')
    }
    expect(foreignBacking instanceof ArrayBuffer).toBe(false)
    const foreign = Buffer.from(foreignBacking, 127, payload.byteLength)
    foreign.set(payload)

    for (const source of [pooled, offset, shared, foreign]) {
      const response = await serve(source)
      source.fill(0x7f)
      const clone = response.clone()
      for (const body of [response, clone]) {
        const bytes = Buffer.from(await body.arrayBuffer())
        expect(bytes.byteLength).toBe(payload.byteLength)
        expect(digest(bytes)).toBe(expectedDigest)
        expect(body.bodyUsed).toBe(true)
        await expect(body.arrayBuffer()).rejects.toThrow()
        expect(() => body.clone()).toThrow()
      }
    }
  })

  it('preserves empty bodies and rejects reads after cancellation', async () => {
    const empty = await serve(Buffer.alloc(0))
    expect(empty.status).toBe(200)
    expect((await empty.arrayBuffer()).byteLength).toBe(0)

    const response = await serve(Buffer.from('original preview bytes'))
    if (!response.body) {
      throw new Error('Expected a response body')
    }
    await response.body.cancel()
    expect(response.bodyUsed).toBe(true)
    await expect(response.arrayBuffer()).rejects.toThrow()
  })
})
