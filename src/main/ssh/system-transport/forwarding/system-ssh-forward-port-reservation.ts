/** Resolve port 0 locally because OpenSSH never reports its -L 0 choice; recover fixed ports only from proven Orca forwards. */
import { createServer } from 'node:net'
import { stopOrphanedOrcaSshForward } from './system-ssh-orphaned-forward'

/** Recovery requires supplied ownership evidence; unrelated listeners retain their bind error. */
export async function reserveLocalForwardPort(
  localPort: number,
  orphanArgs?: readonly string[],
  cancelMuxedForward?: () => Promise<boolean>
): Promise<number> {
  try {
    return await bindLocalForwardPort(localPort)
  } catch (error) {
    const inUse = error instanceof Error && error.cause === 'EADDRINUSE'
    if (!inUse || !(await releaseLocalForwardPort(localPort, orphanArgs, cancelMuxedForward))) {
      throw error
    }
    return bindLocalForwardPort(localPort)
  }
}

async function releaseLocalForwardPort(
  localPort: number,
  orphanArgs?: readonly string[],
  cancelMuxedForward?: () => Promise<boolean>
): Promise<boolean> {
  // Only the exact supplied Orca forward argv permits fixed-port process recovery.
  if (orphanArgs && (await stopOrphanedOrcaSshForward(localPort, orphanArgs))) {
    return true
  }
  // A muxed forward survives its client, so process matching cannot recover it.
  return cancelMuxedForward ? cancelMuxedForward() : false
}

/** Probe then release the port; preserve EADDRINUSE as cause to distinguish contention from unusability. */
function bindLocalForwardPort(localPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(`Local port 127.0.0.1:${localPort} is not available: ${err.message}`, {
          cause: err.code
        })
      )
    })
    server.once('listening', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : localPort
      server.close(() => resolve(port))
    })
    server.listen(localPort, '127.0.0.1')
  })
}
