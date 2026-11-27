import { expect, it } from 'vitest'
import { decodeSafariCookie } from './browser-cookie-safari-parser'

it('does not replace a truncated Safari cookie value with an empty value', () => {
  const record = Buffer.alloc(78)
  record.writeUInt32LE(78, 0)
  record.writeUInt32LE(48, 16)
  record.writeUInt32LE(61, 20)
  record.writeUInt32LE(69, 24)
  record.writeUInt32LE(71, 28)
  record.write('example.test\0session\0/\0secret\0', 48)
  expect(decodeSafariCookie(record)?.value).toBe('secret')
  expect(decodeSafariCookie(record.subarray(0, 77))).toBeNull()
  record[77] = 0x61
  expect(decodeSafariCookie(record)).toBeNull()
})
