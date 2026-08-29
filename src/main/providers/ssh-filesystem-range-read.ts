import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { validateFileRangeRequest } from '../../shared/file-range-read'
import {
  FileRangeReadUnsupportedError,
  type FileRangeReadResult
} from './filesystem-provider-contract'

export async function readSshFileRange(
  mux: SshChannelMultiplexer,
  filePath: string,
  rawPosition: number,
  rawLength: number,
  signal?: AbortSignal
): Promise<FileRangeReadResult> {
  // Same validator the host runs, so an out-of-contract request fails locally
  // as a typed error instead of costing a round trip and coming back as an
  // opaque -32000.
  const { position, length } = validateFileRangeRequest(rawPosition, rawLength)
  let result: unknown
  try {
    // No timeoutMs: the multiplexer's 30s default is right for a bounded
    // MAX_FILE_RANGE_READ_BYTES window on a slow link. The capability probe
    // pins a shorter one because it gates a UI decision, not a data read.
    result = await mux.request(
      'fs.readFileRange',
      { filePath, position, length },
      signal ? { signal } : undefined
    )
  } catch (err) {
    // Why throw rather than read the whole file here: a tailing caller issues
    // several reads per snapshot, so a per-call fallback is quadratic on a
    // growing transcript. Callers probe once and snapshot instead.
    if (isMethodNotFoundError(err)) {
      throw new FileRangeReadUnsupportedError()
    }
    throw err
  }
  const payload = result as { base64?: unknown; bytesRead?: unknown } | null
  if (typeof payload?.base64 !== 'string' || typeof payload.bytesRead !== 'number') {
    throw new Error('fs.readFileRange returned a malformed response')
  }
  const bytes = Buffer.from(payload.base64, 'base64')
  // The remote is untrusted for framing: a count that disagrees with the
  // payload would silently shift every downstream offset.
  if (
    !Number.isSafeInteger(payload.bytesRead) ||
    payload.bytesRead < 0 ||
    payload.bytesRead > length ||
    payload.bytesRead !== bytes.length
  ) {
    throw new Error('fs.readFileRange returned an inconsistent byte count')
  }
  return { bytes, bytesRead: payload.bytesRead }
}
