/**
 * The wire contract for realtime tool-call arguments: a JSON object, strings pulled by
 * key. Shared by the tool dispatch and the screen-tool dispatch so both parse the
 * provider's argumentsJson identically.
 */

import { asWireRecord } from './realtime-wire-record'

export function parseToolArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    return asWireRecord(JSON.parse(argumentsJson))
  } catch {
    return null
  }
}

export function readStringArg(args: Record<string, unknown> | null, key: string): string | null {
  const value = args?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}
