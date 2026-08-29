import { describe, expect, it } from 'vitest'
import {
  buildPaperclipApiUrl,
  createPaperclipOriginPolicy,
  parsePaperclipOrigin
} from './paperclip-origin-policy'

describe('Paperclip local origin policy', () => {
  it.each(['http://127.0.0.1:3101', 'http://127.8.9.10', 'http://[::1]:3101'])(
    'accepts literal loopback HTTP: %s',
    (origin) => expect(parsePaperclipOrigin(origin).origin).toBe(origin)
  )

  it.each([
    'http://localhost:3101',
    'https://127.0.0.1:3101',
    'http://10.0.0.1:3101',
    'http://169.254.169.254',
    'http://user:secret@127.0.0.1:3101',
    'http://127.0.0.1:3101/api',
    'http://127.0.0.1:3101/?company=1'
  ])('rejects non-literal or widened input: %s', (origin) => {
    expect(() => parsePaperclipOrigin(origin)).toThrow()
  })

  it('constructs encoded API paths locally', () => {
    const policy = createPaperclipOriginPolicy('http://127.0.0.1:3101')
    expect(buildPaperclipApiUrl(policy, ['issues', 'issue/1', 'active-run'])).toBe(
      'http://127.0.0.1:3101/api/issues/issue%2F1/active-run'
    )
  })
})
