/** Argument checks for extension API handlers: extensions pass whatever they like. */

export function objectArg(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}

export function numberArg(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`)
  }
  return value
}

export function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`)
  }
  return value
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** A URL an extension passes, resolved against its own origin as Chrome does for relative ones. */
export function extensionUrl(extension: Electron.Extension, value: unknown): string {
  return new URL(stringArg(value, 'url'), extension.url).toString()
}
