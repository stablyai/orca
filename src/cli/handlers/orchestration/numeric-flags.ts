import { parsePositiveSafeIntegerText } from '../../../shared/timer-delay'
import { RuntimeClientError } from '../../runtime-client'

export function getOptionalPositiveIntegerValueFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const raw = flags.get(name)
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
  }
  const value = parsePositiveSafeIntegerText(raw)
  if (value === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid positive safe integer for --${name}: ${raw}`
    )
  }
  return value
}
