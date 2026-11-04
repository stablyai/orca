import {
  buildLinearIssueLinkUpdates,
  LINEAR_ISSUE_LINK_CLEARED,
  type LinearIssueLinkUpdates
} from '../../shared/linear/links'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeLinkFlagValue } from './worktree-link-flag-value'

export function getOptionalLinearIssueLinkFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowNull?: boolean } = {}
): LinearIssueLinkUpdates | undefined {
  const value = getOptionalWorktreeLinkFlagValue(flags, name, {
    ...options,
    createHint: 'a Linear issue identifier or URL'
  })
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return { ...LINEAR_ISSUE_LINK_CLEARED }
  }

  // Only literal null unlinks; blank flag values must not inherit the text-field builder's clear behavior.
  const updates = value.trim() === '' ? null : buildLinearIssueLinkUpdates(value)
  if (!updates) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a Linear issue identifier like STA-335, a Linear issue URL, or null to clear.'
    )
  }

  return updates
}
