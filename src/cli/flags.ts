import { RuntimeClientError } from './runtime-client'

export function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
}

export function getOptionalStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function getOptionalNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = flags.get(name)
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
  if (value === 'null') {
    return null
  }
  return getOptionalNumberFlag(flags, name)
}
