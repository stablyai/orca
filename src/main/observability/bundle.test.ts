import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internalsForTests, collectBundle } from './bundle'
import { validateUploadUrl } from './diagnostic-bundle-upload'

let dir: string
let traceFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-bundle-'))
  traceFile = join(dir, 'main.trace.ndjson')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

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
    durationMs: 1,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  }
}

describe('bundle — collection', () => {
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
  it('rejects http upload_url when tokenEndpoint is https (mixed scheme)', () => {
    expect(() =>
      validateUploadUrl('http://api.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must use https/)
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
})
