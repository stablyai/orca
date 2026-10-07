import { open } from 'node:fs/promises'
import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'
import { BinarySessionTranscriptError } from '../main/ai-vault/remote-session-content-lines'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from './fs-handler-utils'
import { readNodeFileWithinLimit } from '../shared/node-bounded-file-reader'

/** The same open handle supplies the probe and stream, including across renames. */
export async function* readRelayTranscriptBytes(
  path: string,
  signal?: AbortSignal,
  options?: { regularFileOnly: true; maxBytes: number }
): AsyncGenerator<Buffer> {
  throwIfAiVaultScanCancelled(signal)
  if (options?.regularFileOnly) {
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
  const handle = await open(path, 'r')
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    if (isBinaryBuffer(probe.subarray(0, bytesRead))) {
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
