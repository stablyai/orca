import { getActiveMultiplexer } from '../ipc/ssh'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../../shared/cross-platform-path'

type RemoteHomeResolution = { home: string | null; definitive: boolean }

// Why: the home directory is immutable for a connection's lifetime, and the
// base-directory watcher re-resolves it on every rebuild. Key the cache by the
// multiplexer instance so reconnects naturally start fresh.
const remoteHomeByMultiplexer = new WeakMap<object, Promise<RemoteHomeResolution>>()

/**
 * Resolve the SSH host's home directory via the relay.
 * Returns null when the connection is gone, the relay predates
 * session.resolveHome, or the reported path is not a usable absolute path.
 */
export async function resolveSshRemoteHome(connectionId: string): Promise<string | null> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux || mux.isDisposed?.()) {
    return null
  }
  let pending = remoteHomeByMultiplexer.get(mux)
  if (!pending) {
    pending = requestRemoteHome(mux)
    remoteHomeByMultiplexer.set(mux, pending)
    // Why: only definitive answers may stay cached. A transient request
    // failure must not pin the legacy fallback for the connection's lifetime.
    void pending.then((resolution) => {
      if (!resolution.definitive && remoteHomeByMultiplexer.get(mux) === pending) {
        remoteHomeByMultiplexer.delete(mux)
      }
    })
  }
  return (await pending).home
}

async function requestRemoteHome(mux: SshChannelMultiplexer): Promise<RemoteHomeResolution> {
  let resolvedPath: unknown
  try {
    const result = (await mux.request('session.resolveHome', { path: '~' })) as {
      resolvedPath?: unknown
    }
    resolvedPath = result.resolvedPath
  } catch (error) {
    // Why: older relays lack session.resolveHome — that answer is permanent
    // for the connection; any other failure may be transient.
    const unsupported = error instanceof Error && error.message.includes('Method not found')
    return { home: null, definitive: unsupported }
  }
  const home =
    typeof resolvedPath === 'string' ? normalizeRuntimePathSeparators(resolvedPath.trim()) : ''
  const validHome =
    home &&
    (home.startsWith('/') || isWindowsAbsolutePathLike(home)) &&
    !hasRemotePathControlCharacter(home)
      ? home.replace(/\/$/, '')
      : null
  return { home: validHome, definitive: true }
}

function hasRemotePathControlCharacter(value: string): boolean {
  return value.includes(String.fromCharCode(0)) || value.includes('\r') || value.includes('\n')
}
