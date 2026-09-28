import { DaemonConnectionLostError } from '../daemon/daemon-errors'
import { Duplex } from 'node:stream'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { WSL_DAEMON_CONNECTOR_READY } from './wsl-daemon-connector-script'

/** Closing this stream only retires its disposable connector, never the guest daemon. */
export function openWslDaemonConnectorStream(
  spec: ProcessSpec,
  signal: AbortSignal
): Promise<Duplex> {
  signal.throwIfAborted()
  const child = spawnProcess(spec)
  const pair = { readable: child.stdout, writable: child.stdin }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node supports Node-stream pairs; current typings omit them. Byte/EOF tests cover this path.
  const stream = Duplex.from(pair as unknown as Parameters<typeof Duplex.from>[0])
  // A child can fail before the awaiting protocol consumer has installed its listener.
  stream.on('error', () => {})
  stream.once('close', () => child.kill())
  child.once('error', (error) => stream.destroy(error))
  child.once('close', () => stream.end())
  return new Promise((resolve, reject) => {
    let preamble = ''
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      child.stderr.off('data', onStderr)
      child.off('error', fail)
      child.off('close', closed)
      child.stderr.resume()
    }
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      stream.destroy()
      reject(error)
    }
    const closed = () => fail(new DaemonConnectionLostError('Connection lost'))
    const abort = () =>
      fail(new Error('WSL daemon connector connection canceled', { cause: signal.reason }))
    const onStderr = (bytes: Buffer) => {
      preamble += bytes.toString('utf8')
      if (preamble.length > 4096) {
        fail(new Error('WSL daemon connector readiness output exceeded its limit'))
      } else if (preamble === WSL_DAEMON_CONNECTOR_READY) {
        settled = true
        cleanup()
        resolve(stream)
      }
    }
    child.stderr.on('data', onStderr)
    child.once('error', fail)
    child.once('close', closed)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })
}
