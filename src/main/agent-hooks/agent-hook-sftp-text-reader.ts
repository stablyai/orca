import type { SFTPWrapper } from 'ssh2'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'

const READ_CHUNK_BYTES = 64 * 1024

type SftpWithBoundedAgentHookRead = SFTPWrapper & {
  orcaReadFileWithinLimit?: (
    remotePath: string,
    maxBytes: number,
    callback: (error: unknown, data?: string | Buffer) => void
  ) => void
}

export async function readAgentHookRemoteTextFile(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number,
  timeoutMs: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Remote file read limit must be a non-negative safe integer')
  }
  const boundedSftp = sftp as SftpWithBoundedAgentHookRead
  if (typeof boundedSftp.orcaReadFileWithinLimit === 'function') {
    return readWithCallback(remotePath, maxBytes, timeoutMs, (callback) =>
      boundedSftp.orcaReadFileWithinLimit!(remotePath, maxBytes, callback)
    )
  }
  if (typeof sftp.createReadStream !== 'function') {
    return readWithCompatibilityFallback(sftp, remotePath, maxBytes, timeoutMs)
  }

  const stream = sftp.createReadStream(remotePath, {
    start: 0,
    end: maxBytes,
    highWaterMark: READ_CHUNK_BYTES
  })
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let totalBytes = 0
    let retained = Buffer.alloc(0)
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for SFTP readFile ${remotePath}`))
    }, timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    function fail(error: unknown): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stream.destroy()
      reject(error)
    }

    stream.on('data', (chunk: string | Buffer | Uint8Array) => {
      if (settled) {
        return
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > maxBytes) {
        fail(new NodeFileReadTooLargeError(totalBytes, maxBytes))
        return
      }
      if (retained.length < totalBytes) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(READ_CHUNK_BYTES, retained.length * 2, totalBytes)
        )
        const next = Buffer.allocUnsafe(nextCapacity)
        retained.copy(next)
        retained = next
      }
      bytes.copy(retained, totalBytes - bytes.byteLength)
    })
    stream.once('error', fail)
    stream.once('end', () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(retained.toString('utf8', 0, totalBytes))
    })
  })
}

function readWithCompatibilityFallback(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number,
  timeoutMs: number
): Promise<string> {
  return readWithCallback(remotePath, maxBytes, timeoutMs, (callback) => {
    sftp.readFile(remotePath, 'utf8', callback)
  })
}

function readWithCallback(
  remotePath: string,
  maxBytes: number,
  timeoutMs: number,
  start: (callback: (error: unknown, data?: string | Buffer) => void) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for SFTP readFile ${remotePath}`))
    }, timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    function finish(error: unknown, data?: string | Buffer): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
        return
      }
      if (typeof data === 'string') {
        const byteLength = Buffer.byteLength(data, 'utf8')
        if (byteLength > maxBytes) {
          reject(new NodeFileReadTooLargeError(byteLength, maxBytes))
          return
        }
        resolve(data)
        return
      }
      const buffer = data ?? Buffer.alloc(0)
      if (buffer.byteLength > maxBytes) {
        reject(new NodeFileReadTooLargeError(buffer.byteLength, maxBytes))
        return
      }
      resolve(buffer.toString('utf8'))
    }

    try {
      start(finish)
    } catch (error) {
      finish(error)
    }
  })
}
