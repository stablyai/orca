import { open } from 'node:fs/promises'
import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'
import { BinarySessionTranscriptError } from '../main/ai-vault/remote-session-content-lines'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from './fs-handler-utils'
import { dshHomeFromSessionPath } from '../shared/dsh-session-paths'

/** The same open handle supplies the probe and stream, including across renames. */
export async function* readRelayTranscriptBytes(
  path: string,
  signal?: AbortSignal,
  format?: 'dsh-zstd'
): AsyncGenerator<Buffer> {
  throwIfAiVaultScanCancelled(signal)
  const handle = await open(path, 'r')
  try {
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
