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
  const result: unknown = await mux.request('session.resolveHome', { path: '~' })
  const resolvedPath =
    typeof result === 'object' && result !== null && 'resolvedPath' in result
      ? result.resolvedPath
      : undefined
  const home =
    typeof resolvedPath === 'string' ? normalizeRuntimePathSeparators(resolvedPath.trim()) : ''
  return home &&
    (home.startsWith('/') || isWindowsAbsolutePathLike(home)) &&
    !hasRemotePathControlCharacter(home)
    ? home.replace(/\/$/, '')
    : null
}
