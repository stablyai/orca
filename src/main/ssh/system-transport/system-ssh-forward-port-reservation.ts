/**
 * The port a system SSH forward will listen on. OpenSSH binds `-L 0` to a port it never reports,
 * so port 0 is resolved to a free one here first, and a fixed port an earlier Orca left bound is
 * recovered here before the caller gives up on it.
 */
import { createServer } from 'node:net'
import { stopOrphanedOrcaSshForward } from './system-ssh-orphaned-forward'

/**
 * The port the forward should be spawned on: `localPort`, or a free one when it is 0. Recovery is
 * only ever attempted on a port already in use, and only from what the caller supplies — a forward
 * process to stop, a master to ask — so a port held by anything else keeps reporting the bind error.
 */
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

/** True when a forward an earlier Orca left on `localPort` was released, by process or by master. */
async function releaseLocalForwardPort(
  localPort: number,
  orphanArgs?: readonly string[],
  cancelMuxedForward?: () => Promise<boolean>
): Promise<boolean> {
  // Why: a fixed port (a managed tunnel's) may be held by the same forward an earlier Orca
  // orphaned; `orphanArgs` is that forward's argv, the only process recovery may stop.
  if (orphanArgs && (await stopOrphanedOrcaSshForward(localPort, orphanArgs))) {
    return true
  }
  // Why second: a muxed forward outlives its process, so no argv on the table can match it.
  return cancelMuxedForward ? cancelMuxedForward() : false
}

/**
 * The port a listener could be opened on, closed again before it is returned. Rejects with
 * `EADDRINUSE` as the error's `cause`, which is what tells a busy port from an unusable one.
 */
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
