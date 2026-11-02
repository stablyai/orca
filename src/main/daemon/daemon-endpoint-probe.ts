import { connect } from 'node:net'
import { lstatSync } from 'node:fs'

const ENDPOINT_PROBE_TIMEOUT_MS = 500

/** Connected proves a listener; missing/refused prove death; unknown must leave the endpoint alone. */
export type SocketProbeOutcome = 'connected' | 'missing' | 'refused' | 'unknown'

/** Positive proof that nothing is serving the endpoint. A timed-out probe proves nothing. */
export function endpointIsProvenDead(outcome: SocketProbeOutcome): boolean {
  return outcome === 'refused' || outcome === 'missing'
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function probeSocketConnect(socketPath: string): Promise<SocketProbeOutcome> {
  return new Promise((resolve) => {
    let occupiedUnixEntry = false
    if (process.platform !== 'win32') {
      try {
        // lstat sees dangling symlinks that still occupy the endpoint name.
        lstatSync(socketPath)
        occupiedUnixEntry = true
      } catch (error) {
        resolve(isMissingFileError(error) ? 'missing' : 'unknown')
        return
      }
    }
    const sock = connect({ path: socketPath })
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      sock.off('connect', onConnect)
      sock.off('error', onError)
    }
    const settle = (result: SocketProbeOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    const onConnect = (): void => {
      settle('connected')
      sock.destroy()
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      settle(
        // Non-sockets report ENOTSOCK on macOS and ECONNREFUSED on Linux.
        error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK'
          ? 'refused'
          : error.code === 'ENOENT'
            ? // A dangling symlink occupies the name but cannot serve it.
              occupiedUnixEntry
              ? 'refused'
              : 'missing'
            : 'unknown'
      )
    }
    const timer = setTimeout(() => {
      settle('unknown')
      sock.destroy()
    }, ENDPOINT_PROBE_TIMEOUT_MS)
    sock.on('connect', onConnect)
    sock.on('error', onError)
  })
}
