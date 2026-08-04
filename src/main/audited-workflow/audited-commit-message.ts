// Commit-message canonicalization (Phase 8), reusing the MESSAGE_REASON_CODES
// vocabulary declared since Phase 1.
//
// The message is the one renderer-authored INPUT in this lane. It travels
// main-ward only: it is never echoed onto a projection, never logged, and never
// placed in argv (commit-tree reads it from a file, because process listings are
// world-readable on most platforms).
import { createHash } from 'node:crypto'
import { MAX_COMMIT_MESSAGE_BYTES } from '../../shared/audited-commit-types'
import type { MessageReasonCode } from '../../shared/audited-workflow-types'

export type CanonicalMessageResult =
  | { ok: true; text: string; sha256: string }
  | { ok: false; reasonCode: Exclude<MessageReasonCode, 'message_ok'> }

/**
 * Canonicalizes a commit message and hashes it.
 *
 * The hash is persisted as `intended_message_sha` so crash recovery can prove the
 * commit Git created carries the message that was actually authorized — not a
 * different one from a concurrent attempt.
 */
export function canonicalizeCommitMessage(raw: string): CanonicalMessageResult {
  // A NUL would truncate the message for any C-string reader, including Git.
  if (raw.includes('\0')) {
    return { ok: false, reasonCode: 'message_contains_nul' }
  }
  // Lone surrogates cannot be encoded as valid UTF-8; Git would store mojibake.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw)) {
    return { ok: false, reasonCode: 'message_invalid_encoding' }
  }

  // Normalize line endings and guarantee exactly one trailing newline, so the
  // same human input produces the same commit OID on every platform.
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalized.replace(/\s+$/, '')
  const subject = trimmed.split('\n', 1)[0]?.trim() ?? ''
  if (subject.length === 0) {
    return { ok: false, reasonCode: 'message_empty_subject' }
  }

  const text = `${trimmed}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    return { ok: false, reasonCode: 'message_too_large' }
  }

  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  return { ok: true, text, sha256 }
}

/** Hashes an existing commit's message body for evidence comparison. */
export function hashCommitMessageBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}
