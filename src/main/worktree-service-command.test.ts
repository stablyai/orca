import { describe, expect, it } from 'vitest'
import { sanitizeServiceCommandOutput } from './worktree-service-command'

describe('sanitizeServiceCommandOutput', () => {
  it('redacts credentials embedded in connection strings', () => {
    expect(sanitizeServiceCommandOutput('postgres://user:secret@host/db')).toBe(
      'postgres://user:[redacted]@host/db'
    )
  })

  it('redacts labelled secrets', () => {
    expect(sanitizeServiceCommandOutput('PASSWORD=hunter2')).toBe('PASSWORD=[redacted]')
    expect(sanitizeServiceCommandOutput('api_key: abc123')).toBe('api_key: [redacted]')
  })

  it('redacts HTTP authorization headers and bare bearer tokens', () => {
    expect(sanitizeServiceCommandOutput('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: [redacted]'
    )
    expect(sanitizeServiceCommandOutput('sent Bearer sk-secret-token now')).toBe(
      'sent Bearer [redacted] now'
    )
  })

  it('caps output at 2000 characters', () => {
    expect(sanitizeServiceCommandOutput('x'.repeat(5000))).toHaveLength(2000)
  })
})
