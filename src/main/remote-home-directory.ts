import { getActiveMultiplexer } from './ssh/ssh-target-registry'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../shared/cross-platform-path'

function hasRemotePathControlCharacter(value: string): boolean {
  return value.includes(String.fromCharCode(0)) || value.includes('\r') || value.includes('\n')
}

/** Resolve an SSH host's home directory, or null when the connection cannot answer. */
export async function resolveRemoteHomeDirectory(connectionId: string): Promise<string | null> {
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
