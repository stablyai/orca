import { resolveOrcadBindHost } from '../../main/orcad/orcad-bind-address'
import { getPresentStringFlag } from '../flags'
import { RuntimeClientError } from './types'

/** Convert a CLI bind value into the normalized literal address used by serve. */
export function resolveServeBindValue(raw: string): string {
  try {
    return resolveOrcadBindHost(raw)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      error instanceof Error ? error.message : `Invalid --bind value: ${raw}`
    )
  }
}

/** Return undefined only when the flag is absent; explicit empty values are invalid. */
export function getOptionalServeBind(flags: Map<string, string | boolean>): string | undefined {
  const raw = getPresentStringFlag(flags, 'bind')
  return raw === undefined ? undefined : resolveServeBindValue(raw)
}
