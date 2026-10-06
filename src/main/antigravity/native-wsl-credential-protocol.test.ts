import { expect, it } from 'vitest'
import {
  decodeAntigravityWslReply,
  encodeAntigravityWslWrite
} from './native-wsl-credential-protocol'
const nonce = 'abc123'
it('encodes secret bytes only in the fixed stdin protocol', () => {
  expect(encodeAntigravityWslWrite('secret\n', null)).toBe(
    'ORCA_AGY_WSL_INPUT_V1\nmissing\nc2VjcmV0Cg==\n'
  )
})
it('decodes the exact framed UTF-8 bytes', () => {
  expect(
    decodeAntigravityWslReply(`ORCA_AGY_WSL_REPLY_V1 ${nonce}\npresent\nc2VjcmV0Cg==\n`, nonce)
  ).toEqual({ status: 'present', contents: 'secret\n' })
  expect(decodeAntigravityWslReply(`ORCA_AGY_WSL_REPLY_V1 ${nonce}\nmissing\n\n`, nonce)).toEqual({
    status: 'missing'
  })
})
it.each([
  'wrong\nmissing\n\n',
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\npresent\nYQ\n`,
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\npresent\n/w==\n`,
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\nmissing\nYQ==\n`,
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\nmissing\n\nextra\n`
])('rejects malformed frames without echoing secret payloads', (output) => {
  expect(() => decodeAntigravityWslReply(output, nonce)).toThrow('protocol')
})
it('enforces token and transport bounds', () => {
  expect(() => encodeAntigravityWslWrite('x'.repeat(65537), null)).toThrow('size')
  expect(() => decodeAntigravityWslReply('x'.repeat(192 * 1024 + 1), nonce)).toThrow('protocol')
})
