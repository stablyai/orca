import { resolveOrcadBindHost } from '../../shared/runtime-bind-address'
import { RuntimeClientError } from './types'

export function getOptionalServeBind(flags: Map<string, string | boolean>): string | null {
  if (!flags.has('bind')) {
    return null
  }
  const rawBind = flags.get('bind')
  if (typeof rawBind !== 'string' || rawBind.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --bind.')
  }
  return resolveServeBindHost(rawBind)
}

/** Resolve before any child starts, including the runtime-selection process. */
export function resolveServeBindHost(raw: string): string {
  try {
    return resolveOrcadBindHost(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid --bind value.'
    throw new RuntimeClientError('invalid_argument', message)
  }
}
