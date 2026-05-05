// Why: every RPC response needs the same runtimeId envelope, and the
// runtime/browser error allowlists define the contract the CLI relies on to
// format human-facing messages. Centralizing this mapping keeps the allowlist
// auditable in one place instead of spread across per-method branches.
import type { RpcEnvelopeMeta, RpcFailure, RpcSuccess } from './core'

export function successResponse(id: string, meta: RpcEnvelopeMeta, result: unknown): RpcSuccess {
  return {
    id,
    ok: true,
    result,
    _meta: meta
  }
}

export function errorResponse(
  id: string,
  meta: RpcEnvelopeMeta,
  code: string,
  message: string,
  data?: unknown
): RpcFailure {
  return {
    id,
    ok: false,
    error: data === undefined ? { code, message } : { code, message, data },
    _meta: meta
  }
}

// Why: the OrcaRuntimeService throws plain Error objects whose `message` is
// actually a stable error code. This allowlist is the contract the CLI relies
// on — expanding or renaming entries without updating the CLI would silently
// change user-visible error codes.
const RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'runtime_unavailable',
  'selector_not_found',
  'selector_ambiguous',
  'terminal_handle_stale',
  'terminal_not_writable',
  'terminal_exited',
  'terminal_gone',
  'no_active_terminal',
  'repo_not_found',
  'timeout',
  'invalid_limit'
])

export function mapRuntimeError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (RUNTIME_PASSTHROUGH_CODES.has(message)) {
    return errorResponse(id, meta, message, message)
  }
  if (message === 'invalid_terminal_send') {
    return errorResponse(id, meta, 'invalid_argument', 'Missing terminal send payload')
  }
  return errorResponse(id, meta, 'runtime_error', message)
}

// Why: browser errors carry a structured .code property (BrowserError from
// cdp-bridge.ts) that maps directly to agent-facing error codes. We forward
// that code rather than falling back to the runtime allowlist, because the
// browser surface area uses its own code namespace (browser_no_tab, etc.).
export function mapBrowserError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return errorResponse(id, meta, (error as { code: string }).code, error.message)
  }
  return mapRuntimeError(id, meta, error)
}
