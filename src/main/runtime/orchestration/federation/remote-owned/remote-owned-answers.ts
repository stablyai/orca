import { OrchestrationError } from '../../orchestration-error'
import { serverAnswered } from './remote-owed-actions'
import type { RemoteForwardKey } from './remote-forward-caller'

/** The server got nothing, or never answered, so whatever the call did there is unknown here. */
export function serverNeverAnswered(error: unknown): boolean {
  return !serverAnswered(error)
}

export function errorData(error: unknown): Record<string, unknown> | undefined {
  const data = error instanceof Error && 'data' in error ? error.data : undefined
  return data && typeof data === 'object' && !Array.isArray(data)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-array object's own fields, read as unknowns.
      (data as Record<string, unknown>)
    : undefined
}

/** What the server's answer says that this Orca says otherwise. */
export type ServerTerms = {
  server: string
  forward?: RemoteForwardKey
  /** The link the call went under: the server's Run for it is this Orca's Run here. */
  link?: { peer_run_id: string | null; run_id: string }
}

/**
 * The server's answer, or its error, in the caller's own terms: the caller knows its request ID,
 * not the scoped key the server saw, and its own Run, not the server's; an error names the server
 * it came from so recovery (`request-show --on`) asks there.
 */
export function inServerTerms<T>(value: T, { server, forward, link }: ServerTerms): T {
  const pairs: [string, string][] = []
  if (forward) {
    pairs.push([forward.key, forward.requestId])
  }
  if (link?.peer_run_id) {
    pairs.push([link.peer_run_id, link.run_id])
  }
  const swap = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return pairs.reduce((text, [from, to]) => text.split(from).join(to), item)
    }
    if (Array.isArray(item)) {
      return item.map(swap)
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([field, inner]) => [field, swap(inner)]))
    }
    return item
  }
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : 'runtime_error'
    const data = Object.entries(errorData(value) ?? {}).map(([field, inner]) => [
      field,
      swap(inner)
    ])
    const error = new OrchestrationError(code, String(swap(value.message)), {
      ...Object.fromEntries(data),
      server
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an error answer stays an error, with the same code.
    return error as T
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only string contents change; every shape is kept.
  return swap(value) as T
}
