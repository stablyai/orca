import { normalizeRepoBadgeColor } from '../../shared/repository/appearance/repo-badge-color'
import { getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

/** A normalized `#rrggbb`; null for `none` where the flag may clear; undefined when absent. */
export function getOptionalHexColorFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowNone: boolean }
): string | null | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (options.allowNone && value === 'none') {
    return null
  }
  const color = normalizeRepoBadgeColor(value)
  if (!color) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} must be a hex color such as #22c55e${options.allowNone ? ', or none' : ''}.`
    )
  }
  return color
}
