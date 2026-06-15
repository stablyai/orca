/* oxlint-disable max-lines -- Why: diagnostics bundle fixtures cover collection, preview deletion, upload URL hardening, and byte caps as one contract surface. Splitting would duplicate the temp-file/server harness and make edge-case coverage harder to audit. */
// Bundle collection + upload tests. Upload helpers live outside bundle.ts, but
// this suite keeps the diagnostic bundle contract in one place.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internalsForTests, collectBundle, generateBundleSubmissionId } from './bundle'
import { deleteBundle, uploadBundle, validateUploadUrl } from './diagnostic-bundle-upload'
import { MAX_RESPONSE_BYTES } from './diagnostic-upload-http'

let dir: string
let traceFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-bundle-'))
  traceFile = join(dir, 'main.trace.ndjson')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeNDJSON(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
}

function makeSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = BigInt(Date.now()) * 1_000_000n
  return {
    type: 'effect-span',
    name: 'test',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: String(now - 1_000_000_000n),
    endTimeUnixNano: String(now),
    durationMs: 1.0,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  }
}

describe('bundle — submission ID', () => {
  it('is base64url, 22 chars (128 bits)', () => {
    const id = generateBundleSubmissionId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
  it('is unique across many calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateBundleSubmissionId())
    }
    expect(ids.size).toBe(100)
  })
})

describe('bundle — collection', () => {
  it('emits a header line with bundle_submission_id, app_version, platform', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan()]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.0.0',
      orcaChannel: 'dev'
    })
    const lines = bundle.payload.split('\n').filter(Boolean)
    const header = JSON.parse(lines[0])
    expect(header.type).toBe('bundle-header')
    expect(header.bundle_submission_id).toBe(bundle.bundleSubmissionId)
    expect(header.app_version).toBe('1.2.3')
    expect(header.platform).toBe('darwin')
    expect(header.arch).toBe('arm64')
    expect(header.orca_channel).toBe('dev')
    expect(header.schema_version).toBe(1)
  })

  it('NEVER carries install_id in the header (Issue 8)', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan()]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    const header = JSON.parse(bundle.payload.split('\n')[0])
    expect(header).not.toHaveProperty('install_id')
    expect(header).not.toHaveProperty('installId')
    expect(header).not.toHaveProperty('distinct_id')
  })

  it('reads spans from the rotated family', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan({ name: 'a' })]))
    writeFileSync(`${traceFile}.1`, makeNDJSON([makeSpan({ name: 'b' })]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.spanCount).toBe(2)
  })

  it('drops spans older than the lookback window', () => {
    const oldNanos = BigInt(Date.now() - 60 * 60 * 1000) * 1_000_000n // 1h ago
    writeFileSync(
      traceFile,
      makeNDJSON([
        makeSpan({ name: 'recent' }),
        makeSpan({
          name: 'old',
          startTimeUnixNano: String(oldNanos - 1n),
          endTimeUnixNano: String(oldNanos)
        })
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    // Header + recent only.
    expect(bundle.spanCount).toBe(1)
    expect(bundle.payload).toContain('"name":"recent"')
    expect(bundle.payload).not.toContain('"name":"old"')
  })

  it('runs the redactor on the merged payload (belt-and-suspenders)', () => {
    // Simulate a sink-write bug that leaked a secret through. The bundle
    // pass should still strip it.
    const span = makeSpan({
      attributes: {
        // raw secret embedded in serialized form — bypass the API surface.
        leaked: `sk-ant-api03-${'a'.repeat(50)}`
      }
    })
    writeFileSync(traceFile, makeNDJSON([span]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).not.toContain('sk-ant-api03-aaaaa')
    expect(bundle.payload).toContain('[redacted:anthropic-key]')
  })

  it('uses server-mode structured redaction for nested auth and identity keys', () => {
    writeFileSync(
      traceFile,
      makeNDJSON([
        makeSpan({
          attributes: {
            install_id: 'posthog-install-id',
            request: {
              headers: {
                authorization: 'Bearer plain-secret',
                cookie: 'sid=plain-secret',
                keep: 'ok'
              }
            }
          }
        })
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).not.toContain('posthog-install-id')
    expect(bundle.payload).not.toContain('plain-secret')
    expect(bundle.payload).not.toContain('authorization')
    expect(bundle.payload).not.toContain('cookie')
    expect(bundle.payload).toContain('"keep":"ok"')
  })

  it('does not append a span that would push the payload over the upload cap', () => {
    const giantSpan = makeSpan({
      attributes: {
        message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES)
      }
    })
    writeFileSync(traceFile, makeNDJSON([giantSpan]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    expect(bundle.spanCount).toBe(0)
  })

  it('keeps the newest spans when the bundle size cap truncates a file', () => {
    const oldSpan = makeSpan({
      name: 'oldest',
      attributes: { message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES) }
    })
    const newSpan = makeSpan({ name: 'newest', attributes: { message: 'recent crash' } })
    writeFileSync(traceFile, makeNDJSON([oldSpan, newSpan]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).toContain('"name":"newest"')
    expect(bundle.payload).not.toContain('"name":"oldest"')
  })

  it('skips individually oversized recent spans and keeps smaller recent context', () => {
    const tooLargeSpan = makeSpan({
      name: 'oversized',
      attributes: { message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES) }
    })
    const usefulSpan = makeSpan({
      name: 'useful',
      attributes: { message: 'still useful' }
    })
    writeFileSync(traceFile, makeNDJSON([usefulSpan, tooLargeSpan]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).toContain('"name":"useful"')
    expect(bundle.payload).not.toContain('"name":"oversized"')
  })

  it('skips oversized middle spans after accepting newer context', () => {
    const olderUseful = makeSpan({ name: 'older-useful', attributes: { message: 'older context' } })
    const oversizedMiddle = makeSpan({
      name: 'oversized-middle',
      attributes: { message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES) }
    })
    const newestUseful = makeSpan({ name: 'newest-useful', attributes: { message: 'new context' } })
    writeFileSync(traceFile, makeNDJSON([olderUseful, oversizedMiddle, newestUseful]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).toContain('"name":"newest-useful"')
    expect(bundle.payload).toContain('"name":"older-useful"')
    expect(bundle.payload).not.toContain('"name":"oversized-middle"')
  })

  it('skips malformed (non-JSON) lines without throwing', () => {
    writeFileSync(traceFile, [JSON.stringify(makeSpan()), 'not json', ''].join('\n'))
    expect(() =>
      collectBundle({
        traceFilePath: traceFile,
        maxFiles: 10,
        appVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '24',
        orcaChannel: 'dev'
      })
    ).not.toThrow()
  })

  it('skips valid JSON lines that are not span objects without throwing', () => {
    writeFileSync(
      traceFile,
      [JSON.stringify(makeSpan({ name: 'valid' })), 'null', '"string"', '42', '[1]', ''].join('\n')
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })

    expect(bundle.spanCount).toBe(1)
    expect(bundle.payload).toContain('"name":"valid"')
  })
})

describe('validateUploadUrl', () => {
  it('allows https upload_url when tokenEndpoint is https', () => {
    expect(() =>
      validateUploadUrl('https://api.example.com/upload', 'https://api.example.com/token')
    ).not.toThrow()
  })

  it('rejects http upload_url when tokenEndpoint is https (mixed scheme)', () => {
    expect(() =>
      validateUploadUrl('http://api.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must use https/)
  })

  it('allows http upload_url when tokenEndpoint is http (localhost dev)', () => {
    expect(() =>
      validateUploadUrl('http://localhost:8080/upload', 'http://localhost:8080/token')
    ).not.toThrow()
  })

  it('rejects an unparseable upload_url', () => {
    expect(() => validateUploadUrl('not a url', 'https://api.example.com/token')).toThrow(
      /invalid upload_url/
    )
  })

  it('rejects a mismatched host even when both are https (same-origin pin)', () => {
    expect(() =>
      validateUploadUrl('https://attacker.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must match tokenEndpoint host/)
  })

  it('rejects a non-http(s) scheme like file://', () => {
    expect(() => validateUploadUrl('file:///tmp/upload', 'https://api.example.com/token')).toThrow(
      /must use https/
    )
  })
})

describe('uploadBundle and deleteBundle', () => {
  let server: Server | null = null

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!server) {
          resolve()
          return
        }
        server.close(() => {
          server = null
          resolve()
        })
      })
  )

  function listen(handler: RequestListener): Promise<string> {
    server = createServer(handler)
    return new Promise((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        if (address && typeof address === 'object') {
          resolve(`http://127.0.0.1:${address.port}`)
        }
      })
    })
  }

  it('does not include token endpoint response bodies in thrown errors', async () => {
    const secretBody = 'internal token service detail: sk-ant-api03-secret'
    const baseUrl = await listen((_req, res) => {
      res.statusCode = 500
      res.end(secretBody)
    })
    await expect(
      uploadBundle({
        tokenEndpoint: `${baseUrl}/token`,
        payload: '{}\n',
        bundleSubmissionId: generateBundleSubmissionId()
      })
    ).rejects.toThrow(/^HTTP 500$/)
  })

  it('does not include upload endpoint response bodies in thrown errors', async () => {
    const secretBody = 'internal upload detail: ghp_secret'
    const baseUrl = await listen((req, res) => {
      if (req.url === '/token') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            token: 'test-token',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            upload_url: `${baseUrl}/upload`,
            max_bytes: _internalsForTests.MAX_BUNDLE_BYTES
          })
        )
        return
      }
      res.statusCode = 500
      res.end(secretBody)
    })
    await expect(
      uploadBundle({
        tokenEndpoint: `${baseUrl}/token`,
        payload: '{}\n',
        bundleSubmissionId: generateBundleSubmissionId()
      })
    ).rejects.toThrow(/^HTTP 500$/)
  })

  it('does not include malformed upload_url values in thrown errors', async () => {
    const secretUrl = 'not a url with sk-ant-api03-secret'
    const baseUrl = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          token: 'test-token',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          upload_url: secretUrl,
          max_bytes: _internalsForTests.MAX_BUNDLE_BYTES
        })
      )
    })
    await expect(
      uploadBundle({
        tokenEndpoint: `${baseUrl}/token`,
        payload: '{}\n',
        bundleSubmissionId: generateBundleSubmissionId()
      })
    ).rejects.toThrow(/^invalid upload_url from token endpoint$/)
  })

  it('does not include transport error details in thrown errors', async () => {
    const baseUrl = await listen((req) => {
      // Why: external DNS failures are CI-timing dependent; destroying a local
      // socket exercises the same transport-error redaction path deterministically.
      req.socket.destroy(new Error('transport detail with sk-ant-api03-secret'))
    })
    await expect(
      uploadBundle({
        tokenEndpoint: `${baseUrl}/diagnostics/token`,
        payload: '{}\n',
        bundleSubmissionId: generateBundleSubmissionId()
      })
    ).rejects.toThrow(/^diagnostic network request failed$/)
  })

  it('does not include invalid tokenEndpoint values in thrown errors', async () => {
    await expect(
      uploadBundle({
        tokenEndpoint: 'not a url with sk-ant-api03-secret',
        payload: '{}\n',
        bundleSubmissionId: generateBundleSubmissionId()
      })
    ).rejects.toThrow(/^diagnostic endpoint configuration is invalid$/)
  })

  it('caps diagnostic endpoint response bodies', async () => {
    const baseUrl = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('x'.repeat(MAX_RESPONSE_BYTES + 1))
    })

    await expect(
      uploadBundle({
        tokenEndpoint: `${baseUrl}/token`,
        payload: '{}\n',
        bundleSubmissionId: generateBundleSubmissionId()
      })
    ).rejects.toThrow(/^diagnostic response exceeded size limit$/)
  })

  it('posts deletion requests to the diagnostics delete endpoint for a ticket', async () => {
    const ticketId = generateBundleSubmissionId()
    const seen: string[] = []
    const baseUrl = await listen((req, res) => {
      seen.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end('{}')
    })
    await deleteBundle({ tokenEndpoint: `${baseUrl}/diagnostics/token`, ticketId })
    expect(seen).toEqual([`/diagnostics/delete/${ticketId}`])
  })
})
