import { describe, expect, it, vi } from 'vitest'
import {
  COOKIE_JSON_FILE_MAX_BYTES,
  COOKIE_JSON_FILE_MAX_DEPTH,
  COOKIE_JSON_FILE_MAX_ENTRIES,
  COOKIE_JSON_FILE_MAX_RETAINED_BYTES,
  CookieJsonFileFormatError,
  CookieJsonFileLimitError,
  enforceCookieJsonRetainedBytes,
  visitCookieJsonFileObjects
} from './browser-cookie-json-file-parser'

describe('visitCookieJsonFileObjects', () => {
  it('visits top-level objects in order and counts every entry', () => {
    const onObject = vi.fn()
    const total = visitCookieJsonFileObjects(
      '[{"name":"first"}, 42, ["ignored"], {"name":"last","nested":{"x":1}}]',
      onObject
    )

    expect(total).toBe(4)
    expect(onObject.mock.calls.map(([entry]) => entry)).toEqual([
      { name: 'first' },
      { name: 'last' }
    ])
  })

  it('accepts the exact entry boundary and rejects one over it', () => {
    expect(visitCookieJsonFileObjects('[{},{}]', () => undefined, 2)).toBe(2)
    expect(() => visitCookieJsonFileObjects('[{},{},{}]', () => undefined, 2)).toThrow(
      expect.objectContaining({
        name: CookieJsonFileLimitError.name,
        kind: 'entries',
        observed: 3,
        limit: 2
      })
    )
  })

  it('accepts the retained-byte boundary and rejects one byte over it', () => {
    expect(() => enforceCookieJsonRetainedBytes(COOKIE_JSON_FILE_MAX_RETAINED_BYTES)).not.toThrow()
    expect(() => enforceCookieJsonRetainedBytes(COOKIE_JSON_FILE_MAX_RETAINED_BYTES + 1)).toThrow(
      expect.objectContaining({
        name: CookieJsonFileLimitError.name,
        kind: 'retained-bytes',
        observed: COOKIE_JSON_FILE_MAX_RETAINED_BYTES + 1
      })
    )
  })

  it('accepts the nesting boundary and rejects one level over it', () => {
    expect(
      visitCookieJsonFileObjects(`${'['.repeat(4)}0${']'.repeat(4)}`, () => undefined, 10, 4)
    ).toBe(1)
    expect(() =>
      visitCookieJsonFileObjects(`${'['.repeat(5)}0${']'.repeat(5)}`, () => undefined, 10, 4)
    ).toThrow(
      expect.objectContaining({
        name: CookieJsonFileLimitError.name,
        kind: 'depth',
        observed: 5,
        limit: 4
      })
    )
  })

  it.each([
    { raw: '{"name":"not-an-array"}', kind: 'root' },
    { raw: '[{"name":}]', kind: 'syntax' },
    { raw: '[{"name":"cookie"},]', kind: 'syntax' },
    { raw: '[/* comment */ {"name":"cookie"}]', kind: 'syntax' }
  ])('rejects $kind input without returning partial data', ({ raw, kind }) => {
    expect(() => visitCookieJsonFileObjects(raw, () => undefined)).toThrow(
      expect.objectContaining({ name: CookieJsonFileFormatError.name, kind })
    )
  })

  it('publishes the production file, entry, and retained-data limits', () => {
    expect({
      fileBytes: COOKIE_JSON_FILE_MAX_BYTES,
      depth: COOKIE_JSON_FILE_MAX_DEPTH,
      entries: COOKIE_JSON_FILE_MAX_ENTRIES,
      retainedBytes: COOKIE_JSON_FILE_MAX_RETAINED_BYTES
    }).toEqual({
      fileBytes: 64 * 1024 * 1024,
      depth: 128,
      entries: 250_000,
      retainedBytes: 64 * 1024 * 1024
    })
  })
})
