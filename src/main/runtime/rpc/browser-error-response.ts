import { BrowserError } from '../../browser/browser-error'
import type { RpcEnvelopeMeta, RpcFailure } from './core'
import { errorResponse, mapRuntimeError } from './errors'

// BrowserError.code uses the browser namespace, separate from the runtime message-code allowlist.
export function mapBrowserError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const data = error instanceof BrowserError ? error.data : undefined
    return errorResponse(id, meta, (error as { code: string }).code, error.message, data)
  }
  return mapRuntimeError(id, meta, error)
}
