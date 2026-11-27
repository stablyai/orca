import type { OrcaRuntimeService } from '../../../../orca-runtime'

const MAILBOX_PREFIXES = ['run:', 'dispatch:', 'orca_session_id:', 'bot:']

/**
 * Expand a unique terminal prefix the way `send` addresses a terminal; an exact, stale or mailbox
 * handle is left for the existing authority checks to accept or refuse (#17874).
 */
export async function resolveCheckTerminalHandle(
  runtime: OrcaRuntimeService,
  handle: string
): Promise<string> {
  if (MAILBOX_PREFIXES.some((prefix) => handle.startsWith(prefix))) {
    return handle
  }
  if (runtime.getTerminalPaneKey(handle)) {
    return handle
  }
  const { terminals } = await runtime.listTerminals(undefined, undefined, {
    includeVisualLayouts: false
  })
  const matches = [...new Set(terminals.map((terminal) => terminal.handle))].filter((candidate) =>
    candidate.startsWith(handle)
  )
  return matches.length === 1 ? matches[0] : handle
}
