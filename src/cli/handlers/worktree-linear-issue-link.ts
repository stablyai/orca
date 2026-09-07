import {
  buildLinearIssueLinkUpdates,
  LINEAR_ISSUE_LINK_CLEARED,
  type LinearIssueLinkUpdates
} from '../../shared/linear/links'
import { RuntimeClientError } from '../runtime-client'

export function getOptionalLinearIssueLinkFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowNull?: boolean } = {}
): LinearIssueLinkUpdates | undefined {
  const value = getPresentStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }

  if (value.trim().toLowerCase() === 'null') {
    if (!options.allowNull) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Omit --linear-issue on create, or pass a Linear issue identifier or URL.'
      )
    }
    return { ...LINEAR_ISSUE_LINK_CLEARED }
  }

  // Why: the shared builder treats empty input as "clear", which is right for a
  // text field the user can blank but wrong for a flag — `--linear-issue "  "`
  // is a mistyped argument, not a request to unlink. Only the literal `null`
  // clears, and that is handled above.
  const updates = value.trim() === '' ? null : buildLinearIssueLinkUpdates(value)
  if (!updates) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a Linear issue identifier like STA-335, a Linear issue URL, or null to clear.'
    )
  }

  return updates
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}
