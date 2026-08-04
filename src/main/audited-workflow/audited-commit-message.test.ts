// Phase 8 — commit message canonicalization, reusing MESSAGE_REASON_CODES.
import { describe, expect, it } from 'vitest'
import { MAX_COMMIT_MESSAGE_BYTES } from '../../shared/audited-commit-types'
import { canonicalizeCommitMessage } from './audited-commit-message'

describe('commit message canonicalization', () => {
  it('normalizes CRLF and guarantees one trailing newline', () => {
    const result = canonicalizeCommitMessage('Subject\r\n\r\nBody\r\n\r\n\r\n')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('Subject\n\nBody\n')
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('produces a stable hash for equivalent platform inputs', () => {
    const crlf = canonicalizeCommitMessage('Subject\r\nBody')
    const lf = canonicalizeCommitMessage('Subject\nBody')
    expect(crlf.ok && lf.ok).toBe(true)
    if (crlf.ok && lf.ok) {
      expect(crlf.sha256).toBe(lf.sha256)
    }
  })

  it.each([
    ['an empty message', ''],
    ['only whitespace', '   \n\n  '],
    ['a blank first line', '\n\nBody only']
  ])('rejects %s with message_empty_subject', (_label, input) => {
    const result = canonicalizeCommitMessage(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('message_empty_subject')
    }
  })

  it('rejects a NUL byte', () => {
    const result = canonicalizeCommitMessage('Subject\0hidden')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('message_contains_nul')
    }
  })

  it('rejects a lone surrogate', () => {
    const result = canonicalizeCommitMessage('Subject \uD800 tail')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('message_invalid_encoding')
    }
  })

  it('rejects an over-long message', () => {
    const result = canonicalizeCommitMessage(`Subject\n${'x'.repeat(MAX_COMMIT_MESSAGE_BYTES)}`)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('message_too_large')
    }
  })

  it('accepts a valid multi-byte message', () => {
    const result = canonicalizeCommitMessage('修复错误\n\n詳細な説明')
    expect(result.ok).toBe(true)
  })
})
