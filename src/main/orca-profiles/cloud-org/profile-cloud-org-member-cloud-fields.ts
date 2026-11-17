import type { OrcaOrgMemberMfa } from '../../../shared/orca-account-mfa'
import type { OrcaOrgMember } from '../../../shared/orca-profiles/orca-profiles'

// The renderer loads this image, so only a plain https URL from auth is kept.
function optionalPictureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) {
    return undefined
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const MEMBER_MFA: readonly OrcaOrgMemberMfa[] = ['on', 'off', 'pending', 'sso']

// Absent for plain members (the server leaves it out); an unknown value is dropped, never guessed.
function normalizeMemberMfa(
  record: Record<string, unknown>
): Pick<OrcaOrgMember, 'mfa' | 'mfaDeadline'> {
  const mfa = MEMBER_MFA.find((status) => status === record.mfa)
  if (!mfa) {
    return {}
  }
  const deadline = record.mfaDeadline
  return mfa === 'pending' && typeof deadline === 'number' && Number.isFinite(deadline)
    ? { mfa, mfaDeadline: deadline }
    : { mfa }
}

/** Orca Cloud's extra roster member fields (avatar, two-factor status); absent keys are omitted. */
export function cloudOrgMemberFields(
  record: Record<string, unknown>
): Pick<OrcaOrgMember, 'pictureUrl' | 'mfa' | 'mfaDeadline'> {
  const pictureUrl = optionalPictureUrl(record.pictureUrl)
  return { ...(pictureUrl ? { pictureUrl } : {}), ...normalizeMemberMfa(record) }
}
