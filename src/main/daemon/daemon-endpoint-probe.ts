/* Classifies what, if anything, is serving the daemon's endpoint. Kept in its own module so
   both the publishing daemon and the launcher can ask, without the ownership rules having to
   depend on the health checker that also uses them. */
import { connect } from 'node:net'
import { lstatSync } from 'node:fs'

const ENDPOINT_PROBE_TIMEOUT_MS = 500

/**
 * 'connected' — something is listening. 'missing'/'refused' — nothing is, and the endpoint
 * name is safe to replace. 'unknown' — the probe itself failed (timeout on a loaded host,
 * EPERM); the endpoint must be left alone because absence of proof is not proof of death.
 */
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
        // Why lstat: existsSync follows symlinks, so a dangling one reads as absent while it
        // still occupies the name — an endpoint nothing can serve and no publish can take.
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
        // Why both: a non-socket occupying the name reports ENOTSOCK on macOS but
        // ECONNREFUSED on Linux. Either way nothing can ever serve it.
        error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK'
          ? 'refused'
          : error.code === 'ENOENT'
            ? // An entry we just saw that now refuses to resolve is a dangling symlink:
              // occupied, unservable, and replaceable — not an absent name.
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
