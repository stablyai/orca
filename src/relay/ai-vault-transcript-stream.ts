import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'
import { BinarySessionTranscriptError } from '../main/ai-vault/remote-session-content-lines'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from './fs-handler-utils'
import { dshHomeFromSessionPath } from '../shared/dsh-session-paths'
import { openNodeFileForRead, readNodeFileWithinLimit } from '../shared/node-bounded-file-reader'
import type { RemoteTranscriptReadOptions } from '../main/ai-vault/remote-session-scanner-types'

/** The same open handle supplies the probe and stream, including across renames. */
export async function* readRelayTranscriptBytes(
  path: string,
  signal?: AbortSignal,
  options?: RemoteTranscriptReadOptions
): AsyncGenerator<Buffer> {
  throwIfAiVaultScanCancelled(signal)
  if (typeof options === 'object' && options.regularFileOnly) {
    const read = await readNodeFileWithinLimit(path, options.maxBytes, {
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
  const handle = await openNodeFileForRead(path, {
    regularFileOnly: options === 'dsh-zstd' || dshHomeFromSessionPath(path) !== null,
    signal
  })
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    throwIfAiVaultScanCancelled(signal)
    const compressedDsh =
      options === 'dsh-zstd' &&
      path.endsWith('.zstd') &&
      dshHomeFromSessionPath(path) !== null &&
      bytesRead >= 4 &&
      probe.readUInt32LE(0) === 0xfd2fb528
    if (options === 'dsh-zstd' && !compressedDsh) {
      throw new Error('Expected a canonical DSH Zstandard transcript')
    }
    if (!compressedDsh && isBinaryBuffer(probe.subarray(0, bytesRead))) {
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
