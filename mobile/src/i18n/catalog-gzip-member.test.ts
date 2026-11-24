import { expect, it } from 'vitest'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
import { MOBILE_WEB_CATALOG_MAX_RAW_BYTES } from '../../../src/shared/mobile-web-bundle/catalog-reply-size'
import { inflateCatalogGzip } from './catalog-gzip-member'

const raw = Buffer.from(JSON.stringify({ notice: 'Русский каталог '.repeat(64) }))
const member = gzipSync(raw)
const MAX = MOBILE_WEB_CATALOG_MAX_RAW_BYTES

function inflate(bytes: Uint8Array, expected = raw.length): Buffer {
  return Buffer.from(inflateCatalogGzip(bytes, expected, MAX))
}

function trailer(body: Buffer): Buffer {
  const out = Buffer.alloc(8)
  out.writeUInt32LE(crc32(body), 0)
  out.writeUInt32LE(body.length, 4)
  return out
}

function withHeader(header: Buffer, deflated: Buffer, body = raw): Buffer {
  return Buffer.concat([header, deflated, trailer(body)])
}

it('decodes one member at exactly its declared size, up to the decoded ceiling', () => {
  expect(inflate(member)).toEqual(raw)
  const ceiling = Buffer.alloc(MAX, 97)
  expect(inflate(gzipSync(ceiling), MAX)).toEqual(ceiling)
  expect(() => inflate(member, MAX + 1)).toThrow('output size')
})

it('rejects anything but exactly one complete member', () => {
  for (const bytes of [
    Buffer.concat([member, member]),
    Buffer.concat([member, gzipSync(Buffer.from('{}'))]),
    Buffer.concat([member, Buffer.of(0)]),
    member.subarray(0, -1),
    member.subarray(0, -8)
  ]) {
    expect(() => inflate(bytes)).toThrow('invalid catalog gzip member')
  }
  expect(() => inflate(member, raw.length - 1)).toThrow('invalid catalog gzip member')
  expect(() => inflate(member, raw.length + 1)).toThrow('invalid catalog gzip member')
})

it('stops a member that decodes past its declared size at the output bound', () => {
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024))
  const forged = Buffer.from(bomb)
  forged.writeUInt32LE(1024, forged.length - 4)
  for (const bytes of [bomb, forged]) {
    expect(() => inflate(bytes, 1024)).toThrow('invalid catalog gzip member')
  }
})

it('validates header flags, the optional header checksum and stored block lengths', () => {
  const deflated = deflateRawSync(raw)
  const base = Buffer.from(member.subarray(0, 10))

  const reserved = Buffer.from(base)
  reserved[3] = 0x20
  expect(() => inflate(withHeader(reserved, deflated))).toThrow('invalid catalog gzip member')

  const hcrc = Buffer.from(base)
  hcrc[3] = 0x02
  const check = Buffer.alloc(2)
  check.writeUInt16LE(crc32(hcrc) & 0xffff, 0)
  expect(inflate(withHeader(Buffer.concat([hcrc, check]), deflated))).toEqual(raw)
  check[0] = check[0]! ^ 1
  expect(() => inflate(withHeader(Buffer.concat([hcrc, check]), deflated))).toThrow(
    'invalid catalog gzip member'
  )

  const named = Buffer.from(base)
  named[3] = 0x08
  expect(inflate(withHeader(Buffer.concat([named, Buffer.from('ru.json\0')]), deflated))).toEqual(
    raw
  )

  const stored = Buffer.from(deflateRawSync(raw, { level: 0 }))
  expect(inflate(withHeader(base, stored))).toEqual(raw)
  // A stored block's NLEN must be the complement of LEN.
  stored[3] = stored[3]! ^ 1
  expect(() => inflate(withHeader(base, stored))).toThrow('invalid catalog gzip member')
})
