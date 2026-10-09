import { expect, it } from 'vitest'
import { decodeAntigravityWslReply } from './native-wsl-credential-script'
const nonce = 'abc123'
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
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\nwritten\nYQ==\n`,
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\nmissing\nYQ==\n`,
  `ORCA_AGY_WSL_REPLY_V1 ${nonce}\nmissing\n\nextra\n`
])('rejects malformed frames without echoing secret payloads', (output) => {
  expect(() => decodeAntigravityWslReply(output, nonce)).toThrow('protocol')
})
it('enforces token and transport bounds', () => {
  const maximum = 'x'.repeat(65536)
  expect(
    decodeAntigravityWslReply(
      `ORCA_AGY_WSL_REPLY_V1 ${nonce}\npresent\n${Buffer.from(maximum).toString('base64')}\n`,
      nonce
    )
  ).toEqual({ status: 'present', contents: maximum })
  expect(() =>
    decodeAntigravityWslReply(
      `ORCA_AGY_WSL_REPLY_V1 ${nonce}\npresent\n${Buffer.from('x'.repeat(65537)).toString('base64')}\n`,
      nonce
    )
  ).toThrow('protocol')
  expect(() => decodeAntigravityWslReply('x'.repeat(192 * 1024 + 1), nonce)).toThrow('protocol')
})
