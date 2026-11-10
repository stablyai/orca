import { OrchestrationError } from '../../orchestration-error'
import { serverAnswered } from './remote-owed-actions'
import type { RemoteForwardKey } from './remote-forward-caller'

/** The server got nothing, or never answered, so whatever the call did there is unknown here. */
export function serverNeverAnswered(error: unknown): boolean {
  return !serverAnswered(error)
}

export function errorData(error: unknown): Record<string, unknown> | undefined {
  const data = error instanceof OrchestrationError ? error.data : undefined
  return data && typeof data === 'object' && !Array.isArray(data)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-array object's own fields, read as unknowns.
      (data as Record<string, unknown>)
    : undefined
}

/**
 * The server's answer, or its error, in the caller's own terms: the caller knows its request ID,
 * not the scoped key the server saw, and an error names the server it came from so recovery
 * (`request-show --on`) asks there.
 */
export function inServerTerms<T>(
  value: T,
  forward: RemoteForwardKey | undefined,
  server: string
): T {
  const swap = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return forward ? item.split(forward.key).join(forward.requestId) : item
    }
    if (Array.isArray(item)) {
      return item.map(swap)
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([field, inner]) => [field, swap(inner)]))
    }
    return item
  }
  if (value instanceof OrchestrationError) {
    const data = swap(errorData(value) ?? {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an error stays an OrchestrationError with the same code.
    return new OrchestrationError(value.code, String(swap(value.message)), {
      ...(data as Record<string, unknown>),
      server
    }) as T
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only string contents change; every shape is kept.
  return swap(value) as T
}
