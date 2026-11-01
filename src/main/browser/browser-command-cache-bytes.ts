import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'

export const BROWSER_COMMAND_CACHE_MAX_BYTES = 32 * 1024 * 1024
export const BROWSER_COMMAND_CACHE_MAX_BYTES_PER_PAGE = 8 * 1024 * 1024

export function browserCommandCacheBytes(
  event: BrowserClientHostCommandEvent,
  result: BrowserClientHostCommandResult | undefined
): number | null {
  if (!result) {
    return null
  }
  try {
    return (
      Buffer.byteLength(JSON.stringify(event), 'utf8') +
      Buffer.byteLength(JSON.stringify(result), 'utf8')
    )
  } catch {
    return null
  }
}
