import { getActiveMultiplexer } from './ssh-target-registry'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../../shared/cross-platform-path'

function hasRemotePathControlCharacter(value: string): boolean {
  return value.includes(String.fromCharCode(0)) || value.includes('\r') || value.includes('\n')
}

/**
 * The execution host's home directory, or null when it cannot be established.
 *
 * Null is the honest answer for every failure here — a disposed multiplexer, a
 * relay that does not answer, or a path that is not absolute. Callers write
 * vendor files under this path, so guessing one would write to the wrong place.
 */
export async function resolveRemoteAgentHome(connectionId: string): Promise<string | null> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux || mux.isDisposed?.()) {
    return null
  }
  const result = (await mux.request('session.resolveHome', { path: '~' })) as {
    resolvedPath?: unknown
  }
  const home =
    typeof result.resolvedPath === 'string'
      ? normalizeRuntimePathSeparators(result.resolvedPath.trim())
      : ''
  return home &&
    (home.startsWith('/') || isWindowsAbsolutePathLike(home)) &&
    !hasRemotePathControlCharacter(home)
    ? home.replace(/\/$/, '')
    : null
}
