import { describe, expect, it } from 'vitest'
import { createProviderStderrTail } from './provider-stderr-tail'

describe('provider stderr tail', () => {
  it('redacts colored credential labels before exposing diagnostics', () => {
    const tail = createProviderStderrTail(8192)
    const bytes = Buffer.from(
      '\u001b[31mMY_CREDENTIAL\u001b(B\u001b[m=private-value\nfailed to start 🔒'
    )
    for (const byte of bytes) {
      tail.write(Buffer.from([byte]))
    }
    expect(tail.text()).toBe('MY_CREDENTIAL=[redacted:env-value]\nfailed to start 🔒')
  })

  it('withholds PEM bodies while streaming beyond the capture limit', () => {
    const tail = createProviderStderrTail(128)
    tail.write('-----BEGIN PRI')
    tail.write('VATE KEY-----\n')
    for (let index = 0; index < 10; index++) {
      tail.write('sensitive-key-material\n')
      expect(tail.text()).not.toContain('sensitive-key-material')
    }
    tail.write('-----END PRIVATE KEY-----\nprovider: not signed in')
    expect(tail.text()).toContain('provider: not signed in')
    expect(tail.text()).not.toContain('sensitive-key-material')
  })

  it('bounds expanded redaction tags without exposing partial credentials', () => {
    const tail = createProviderStderrTail(128)
    tail.write(`${'A=x\n'.repeat(20)}${'😀'.repeat(11)}\n`)
    expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(128)
    expect(tail.text()).not.toContain('=x')
  })
})
