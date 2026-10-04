import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseJsonObject } from './session-scanner-values'
import {
  parseReasonixManifest,
  parseReasonixWorkspaceHeader
} from './session-scanner-reasonix-metadata'

const id = 'c6ba053c5f6f35229354dbd95635c82d'
const bytes = readFileSync(
  join(__dirname, '__fixtures__', 'reasonix-1-39-7-loopback.manifest.json')
)
const manifest = parseJsonObject(bytes.toString('utf8'))
if (!manifest) {
  throw new Error('Actual manifest fixture is invalid')
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value))

it('reads the actual pinned binary manifest without inventing workspace ownership', () => {
  expect(parseReasonixManifest(bytes, id)).toEqual({
    sessionId: id,
    createdAt: '2026-10-02T10:30:49.887303Z',
    contentRoot: '../.content-v1'
  })
})

it.each([
  { sessionId: 'other' },
  { schemaVersion: 5 },
  { storageRevision: 0 },
  { storageRevision: 4 },
  { codec: 'unknown' },
  { contentRoot: '../../outside' },
  { contentRoot: '/outside' },
  { createdAt: 'invalid' },
  { createdAt: '2026' },
  { createdAt: '0001-01-01T00:00:00Z' }
])('refuses unsupported or mismatched native metadata %j', (change) => {
  expect(() => parseReasonixManifest(encode({ ...manifest, ...change }), id)).toThrow()
})

it('accepts both native fixed content locations and the native default', () => {
  expect(
    parseReasonixManifest(encode({ ...manifest, contentRoot: '.content-v1' }), id).contentRoot
  ).toBe('.content-v1')
  expect(parseReasonixManifest(encode({ ...manifest, contentRoot: null }), id).contentRoot).toBe(
    '../.content-v1'
  )
})

const header = {
  schemaVersion: 1,
  sessionId: id,
  createdAt: manifest.createdAt,
  cwd: '/workspace/folder',
  origin: 'new'
}
it('uses explicit optional Desktop ownership for folder and Windows workspaces', () => {
  expect(parseReasonixWorkspaceHeader(encode(header), id)).toBe('/workspace/folder')
  expect(
    parseReasonixWorkspaceHeader(encode({ ...header, cwd: 'C:\\workspace\\folder' }), id)
  ).toBe('C:\\workspace\\folder')
  expect(parseReasonixWorkspaceHeader(encode({ ...header, cwd: '' }), id)).toBeNull()
})
it.each([
  { schemaVersion: 2 },
  { sessionId: 'other' },
  { cwd: 'relative/folder' },
  { cwd: 123 },
  { origin: 'unknown' },
  { parentSessionId: '../other' },
  { createdAt: 'invalid' },
  { createdAt: '2026' },
  { createdAt: '0001-01-01T00:00:00Z' }
])('fails closed on malformed supplied workspace ownership %j', (change) => {
  expect(() => parseReasonixWorkspaceHeader(encode({ ...header, ...change }), id)).toThrow()
})
it('bounds metadata before JSON parsing', () => {
  expect(() => parseReasonixManifest(Buffer.alloc(64 * 1024 + 1), id)).toThrow('read budget')
})
