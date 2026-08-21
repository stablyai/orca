import { createHash } from 'node:crypto'
import { LINEAR_COMMENT_BODY_CAP } from '../../shared/linear/agent-access'
import {
  LINEAR_PROJECT_ENTITY_OUTPUT_CAP,
  type LinearBoundedEntityCollection,
  type LinearBoundedNullableString,
  type LinearBoundedString
} from '../../shared/linear/project-agent-access'

/** CRLF and lone CR become LF; no trimming and no Unicode normalization. */
export function normalizeLinearLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

export function linearSha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function boundedLinearString(
  value: string,
  cap: number = LINEAR_COMMENT_BODY_CAP
): LinearBoundedString {
  const normalized = normalizeLinearLineEndings(value)
  // Why: count and digest the complete text so recovery can prove equality even when `value` is capped.
  return {
    value: normalized.slice(0, safeSliceEnd(normalized, cap)),
    truncated: normalized.length > cap,
    chars: normalized.length,
    sha256: linearSha256Hex(normalized)
  }
}

export function boundedLinearNullableString(
  value: string | null,
  cap: number = LINEAR_COMMENT_BODY_CAP
): LinearBoundedNullableString {
  if (value === null) {
    // Why: absent text must stay distinguishable from the digest of an empty string.
    return { value: null, truncated: false, chars: 0, sha256: '' }
  }
  return boundedLinearString(value, cap)
}

export function boundedLinearEntityCollection<T extends { id: string }>(
  items: T[],
  cap: number = LINEAR_PROJECT_ENTITY_OUTPUT_CAP
): LinearBoundedEntityCollection<T> {
  const unique = new Map<string, T>()
  for (const item of items) {
    if (!unique.has(item.id)) {
      unique.set(item.id, item)
    }
  }
  const sorted = [...unique.values()].sort((left, right) => compareIds(left.id, right.id))
  const published = cap >= 0 ? sorted.slice(0, cap) : []
  return {
    items: published,
    returned: published.length,
    total: sorted.length,
    truncated: published.length < sorted.length,
    sha256: linearSha256Hex(JSON.stringify(sorted.map((item) => item.id).sort()))
  }
}

function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

/**
 * Why: slicing between a surrogate pair emits a lone half, which is not valid UTF-8 —
 * strict JSON readers (Rust's serde_json) reject the whole payload rather than the char.
 */
function safeSliceEnd(value: string, cap: number): number {
  if (cap <= 0 || cap >= value.length) {
    return cap
  }
  const last = value.charCodeAt(cap - 1)
  return last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap
}
