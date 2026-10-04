import { openRegularFileReadHandle } from '../shared/regular-file-open'
import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'
import { BinarySessionTranscriptError } from '../main/ai-vault/remote-session-content-lines'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from './fs-handler-utils'
import { reasonixSessionLayout } from '../shared/reasonix-session-paths'
import { dshHomeFromSessionPath } from '../shared/dsh-session-paths'
import { readNodeFileHandleWithinLimit } from '../shared/node-bounded-file-reader'
import type { RemoteTranscriptReadOptions } from '../main/ai-vault/remote-session-scanner-types'

/** The same open handle supplies the probe and stream, including across renames. */
export async function* readRelayTranscriptBytes(
  path: string,
  signal?: AbortSignal,
  options?: RemoteTranscriptReadOptions
): AsyncGenerator<Buffer> {
  throwIfAiVaultScanCancelled(signal)
  const errorMessage =
    typeof options === 'object' ? 'Expected a regular file' : 'Expected a regular session file'
  const handle = await openRegularFileReadHandle(path, errorMessage, signal)
  try {
    if (typeof options === 'object') {
      const read = await readNodeFileHandleWithinLimit(handle, options.maxBytes, {
        regularFileOnly: true,
        signal
      })
      if (isBinaryBuffer(read.buffer.subarray(0, BINARY_PROBE_BYTES))) {
        throw new BinarySessionTranscriptError()
      }
      throwIfAiVaultScanCancelled(signal)
      yield read.buffer
      return
    }
    const format = options
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    const compressedDsh =
      format === 'dsh-zstd' &&
      path.endsWith('.zstd') &&
      dshHomeFromSessionPath(path) !== null &&
      bytesRead >= 4 &&
      probe.readUInt32LE(0) === 0xfd2fb528
    if (format === 'dsh-zstd' && !compressedDsh) {
      throw new Error('Expected a canonical DSH Zstandard transcript')
    }
    const reasonix =
      format === 'reasonix-v4' &&
      reasonixSessionLayout(path) !== null &&
      bytesRead >= 4 &&
      probe.readUInt32BE(0) === 0x52583446
    if (format === 'reasonix-v4' && !reasonix) {
      throw new Error('Expected a canonical Reasonix RX4F transcript')
    }
    if (!compressedDsh && !reasonix && isBinaryBuffer(probe.subarray(0, bytesRead))) {
      throw new BinarySessionTranscriptError()
    }
    const input = handle.createReadStream({ start: 0, autoClose: false, signal })
    try {
      for await (const chunk of input) {
        throwIfAiVaultScanCancelled(signal)
        if (!Buffer.isBuffer(chunk)) {
          throw new TypeError('Expected transcript byte buffer')
        }
        yield chunk
      }
    } finally {
      input.destroy()
    }
  } finally {
    await handle.close()
  }
}
