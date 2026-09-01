import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

type DisplayNameKind = CreateWorktreeArgs['displayNameKind']

export function sanitizeWorktreeDisplayName(input: string): string | undefined {
  const withoutControls = Array.from(input, (char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  }).join('')
  const sanitized = withoutControls
    // Why: titles come from external systems; bidi overrides could visually reorder sidebar text.
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim()

  return sanitized || undefined
}

export function resolveWorktreeCreateDisplayName(
  input: string | undefined,
  kind: DisplayNameKind
): string | undefined {
  if (!input) {
    return undefined
  }
  if (kind !== 'user') {
    return sanitizeWorktreeDisplayName(input)
  }
  const safe = Array.from(input, (char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  })
    .join('')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
  return safe || undefined
}

/** Resolve the create label, including the pre-provenance CLI contract. */
export function resolveWorktreeCreateDisplayNameRequest(
  input: string | undefined,
  kind: DisplayNameKind,
  fallbackName: string,
  cliCreated: boolean,
  nameWasGenerated = false
): { value: string | undefined; kind: DisplayNameKind } {
  // The CLI name is always an explicit command argument; its marker wins over a
  // missing or malformed kind so a future client cannot make it auto-managed.
  // Legacy clients omitted displayNameKind: an explicit displayName was the artifact-title
  // contract, while a name-only request was user-entered unless marked as generated.
  const effectiveKind = cliCreated
    ? 'user'
    : (kind ?? (input !== undefined || nameWasGenerated ? 'generated' : 'user'))
  const effectiveInput = input ?? (effectiveKind === 'user' ? fallbackName : undefined)
  return {
    value: resolveWorktreeCreateDisplayName(effectiveInput, effectiveKind),
    kind: effectiveKind
  }
}

export function resolveWorktreeCreateDisplayNameMeta(
  requestedDisplayName: string | undefined,
  branchName: string,
  kind: DisplayNameKind,
  fallback: { requestedName: string; sanitizedName: string }
): Partial<Pick<WorktreeMeta, 'displayName' | 'displayNameIsPinned'>> {
  if (requestedDisplayName !== undefined) {
    // Generated labels equal to their branch stay automatic; user labels remain fixed even when equal.
    if (kind !== 'user' && requestedDisplayName === branchName) {
      return {}
    }
    return { displayName: requestedDisplayName, displayNameIsPinned: true }
  }
  // A user label that sanitizes away is an empty label, so keep the generated fallback automatic.
  if (kind === 'user') {
    return { displayNameIsPinned: false }
  }
  if (fallback.requestedName === branchName) {
    return { displayName: fallback.requestedName, displayNameIsPinned: false }
  }
  return shouldSetDisplayName(fallback.requestedName, branchName, fallback.sanitizedName)
    ? { displayName: fallback.requestedName, displayNameIsPinned: true }
    : {}
}

export function shouldSetDisplayName(
  requestedName: string,
  branchName: string,
  sanitizedName: string
): boolean {
  return !(branchName === requestedName && sanitizedName === requestedName)
}
