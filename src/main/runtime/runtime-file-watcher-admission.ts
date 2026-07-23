import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const RUNTIME_FILE_WATCHER_MAX_LEASES = 256
export const RUNTIME_FILE_WATCHER_MAX_RETAINED_IDENTITY_BYTES = 16 * 1024 * 1024
export const RUNTIME_FILE_WATCHER_MAX_PATH_BYTES = 64 * 1024
const RUNTIME_FILE_WATCHER_MAX_OWNER_ID_BYTES = 8 * 1024

export class RuntimeFileWatcherAdmission {
  private leases = 0
  private retainedBytes = 0

  claim(runtimeId: string, connectionId: string | undefined, rootPath: string): () => void {
    const identityBytes =
      boundedIdentityBytes(runtimeId, RUNTIME_FILE_WATCHER_MAX_OWNER_ID_BYTES, 'runtime id') +
      boundedIdentityBytes(rootPath, RUNTIME_FILE_WATCHER_MAX_PATH_BYTES, 'root path') +
      (connectionId
        ? boundedIdentityBytes(
            connectionId,
            RUNTIME_FILE_WATCHER_MAX_OWNER_ID_BYTES,
            'connection id'
          )
        : 0)
    if (
      this.leases >= RUNTIME_FILE_WATCHER_MAX_LEASES ||
      this.retainedBytes + identityBytes > RUNTIME_FILE_WATCHER_MAX_RETAINED_IDENTITY_BYTES
    ) {
      throw new Error('Runtime file watcher capacity reached; close an existing watch and retry.')
    }
    this.leases += 1
    this.retainedBytes += identityBytes
    let claimed = true
    return () => {
      if (!claimed) {
        return
      }
      claimed = false
      this.leases -= 1
      this.retainedBytes -= identityBytes
    }
  }

  evidence(): { leases: number; retainedBytes: number } {
    return { leases: this.leases, retainedBytes: this.retainedBytes }
  }
}

function boundedIdentityBytes(value: string, limit: number, field: string): number {
  const measured = measureUtf8ByteLength(value, { stopAfterBytes: limit })
  if (measured.exceededLimit) {
    throw new Error(`Runtime file watcher ${field} exceeds ${limit} UTF-8 bytes.`)
  }
  return measured.byteLength
}
