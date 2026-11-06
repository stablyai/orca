import { startSpan } from '../observability/tracer'

export function traceSessionSearch<T>(
  name: string,
  run: () => T,
  attributes?: Record<string, unknown>
): T {
  const span = startSpan(`aiVault.search.${name}`, { attributes })
  try {
    const result = run()
    if (typeof result === 'boolean') {
      span.setAttribute('committed', result)
    }
    span.end()
    return result
  } catch (error) {
    span.fail(error instanceof Error ? error : String(error))
    throw error
  }
}

export function reportSessionSearchBackgroundError(
  report: (error: unknown) => void,
  error: unknown
): void {
  try {
    report(error)
  } catch {
    // Why: reporting a background failure must not terminate the writer.
  }
}
