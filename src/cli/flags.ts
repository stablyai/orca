import { RuntimeClientError } from './runtime/types'
import { REPEATED_FLAG_SEPARATOR } from './args'
import { describeQuoteStrippedJsonFlag } from './quote-stripped-json-flag'

export function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  rejectValuelessFlag(value, name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
}

export function getRequiredStringFlagAllowingEmpty(
  flags: Map<string, string | boolean>,
  name: string
): string {
  const value = flags.get(name)
  rejectValuelessFlag(value, name)
  if (typeof value === 'string') {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
}

export function getOptionalStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  rejectValuelessFlag(value, name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * A valued flag whose value the shell (or a missing variable) ate parses as `true`. Dropping it
 * silently mints a fresh mutation identity and can deliver a prompt twice (#15180), so every
 * valued-flag accessor refuses the damaged shape by name.
 */
export function rejectValuelessFlag(value: string | boolean | undefined, name: string): void {
  if (value === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} requires a value; it was passed with none.`
    )
  }
}

/**
 * A JSON-valued flag, rejected up front when a native argv boundary stripped its quotes so the
 * error names the shell instead of the user's value (#16706). The value itself is still parsed
 * downstream; this only catches the damaged shape.
 */
export function getOptionalJsonFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const mangled = describeQuoteStrippedJsonFlag(name, value)
  if (mangled) {
    throw new RuntimeClientError('invalid_argument', mangled)
  }
  return value
}

export function getRepeatedStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string[] {
  const value = getOptionalStringFlag(flags, name)
  return value === undefined
    ? []
    : value.split(REPEATED_FLAG_SEPARATOR).filter((entry) => entry.length > 0)
}

export function getOptionalNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = flags.get(name)
  rejectValuelessFlag(value, name)
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}

export function getOptionalPositiveIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  return value
}

export function getOptionalNonNegativeIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid non-negative integer for --${name}`)
  }
  return value
}

export function getRequiredPositiveNumber(
  flags: Map<string, string | boolean>,
  name: string
): number {
  const raw = getRequiredStringFlag(flags, name)
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a positive number`)
  }
  return value
}

export function getRequiredFiniteNumber(
  flags: Map<string, string | boolean>,
  name: string
): number {
  const raw = getRequiredStringFlag(flags, name)
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a valid number`)
  }
  return value
}

export function getOptionalNullableNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | null | undefined {
  const value = flags.get(name)
  rejectValuelessFlag(value, name)
  if (value === 'null') {
    return null
  }
  return getOptionalNumberFlag(flags, name)
}
