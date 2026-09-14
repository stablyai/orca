import { createConnection } from 'node:net'
import { DispatcherClientWriter } from './dispatcher-client-writer'
import { RELAY_SENTINEL } from './protocol'
import { readLaunchVersion, runConnectHandshake } from './relay-handshake'

const CONNECT_TIMEOUT_MS = 5_000

// Why: bridges a new SSH channel to the relay process that owns the live PTYs.
export function runRelayConnectChannel(sockPath: string, endpointCredential?: string): void {
  const myVersion = readLaunchVersion()
  const sock = createConnection({ path: sockPath })
  const stdoutWriter = new DispatcherClientWriter(
    (data, onSettled) =>
      process.stdout.write(data, (error) => {
        onSettled(error ? { ok: false, error } : { ok: true })
      }),
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        process.stdout.once('drain', callback)
        return () => process.stdout.off('drain', callback)
      }
    },
    () => {
      sock.destroy()
      process.exit(1)
    }
  )

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[relay-connect] Connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(
      sock,
      myVersion,
      {
        onAccepted: (leftover: Buffer) => {
          stdoutWriter.enqueue('control', () => Buffer.from(RELAY_SENTINEL), RELAY_SENTINEL.length)
          if (leftover.length > 0) {
            stdoutWriter.enqueue('control', () => leftover, leftover.length)
          }
          process.stdin.pipe(sock)
          sock.on('data', (data: Buffer) => {
            sock.pause()
            let offset = 0
            const writeNext = (): void => {
              if (offset >= data.length) {
                sock.resume()
                return
              }
              const bytes = Math.min(stdoutWriter.producerFrameCapacity, data.length - offset)
              if (bytes <= 0) {
                stdoutWriter.close(new Error('Relay stdout has no producer capacity'))
                return
              }
              const chunk = data.subarray(offset, offset + bytes)
              if (
                !stdoutWriter.enqueue(
                  'ordinary',
                  () => chunk,
                  chunk.length,
                  (result) => {
                    if (!result.ok) {
                      return
                    }
                    offset += bytes
                    writeNext()
                  }
                )
              ) {
                stdoutWriter.close(new Error('Relay stdout bridge capacity exceeded'))
              }
            }
            writeNext()
          })
        }
      },
      endpointCredential
    )
  })

  // Why: Node swallows EPIPE on stdout, so close the bridge and enter relay grace promptly.
  process.stdout.on('error', () => {
    stdoutWriter.close(new Error('Relay stdout closed'))
  })

  sock.on('error', (error) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[relay-connect] Socket error: ${error.message}\n`)
    process.exit(1)
  })

  sock.on('close', async () => {
    await stdoutWriter.waitForIdle()
    process.exit(0)
  })
}
