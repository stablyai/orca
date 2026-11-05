import { RuntimeClientError } from '../runtime-client'

export function getOptionalWorktreeLinkFlagValue(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowNull?: boolean; createHint?: string } = {}
): string | null | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
  }
  if (value.trim().toLowerCase() !== 'null') {
    return value
  }
  if (!options.allowNull) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Omit --${name} on create, or pass ${options.createHint ?? 'a valid link reference'}.`
    )
  }
  return null
}
