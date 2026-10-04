import { dshHomeFromSessionPath } from '../../shared/dsh-session-paths'
import { dshTranscriptLines, localDshTranscriptBytes } from './session-scanner-dsh-stream'

export const MAX_DSH_LOG_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_DSH_LOG_SOURCE_BYTES = 32 * 1024 * 1024

export async function readDshDecodedLogSnapshot(
  path: string,
  bytes?: AsyncIterable<Buffer>
): Promise<{ content: string; isBinary: false; decodedDshHistory: true }> {
  if (!dshHomeFromSessionPath(path)) {
    throw new Error('Not a canonical DSH session log')
  }
  const lines: string[] = []
  let size = 0
  for await (const line of dshTranscriptLines(
    path,
    boundedSource(bytes ?? localDshTranscriptBytes(path))
  )) {
    size += Buffer.byteLength(line, 'utf8') + 1
    if (size > MAX_DSH_LOG_SNAPSHOT_BYTES) {
      throw new Error('Decoded DSH log exceeds the 2 MiB Open log/export limit')
    }
    lines.push(`${line}\n`)
  }
  return { content: lines.join(''), isBinary: false, decodedDshHistory: true }
}

async function* boundedSource(bytes: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let size = 0
  for await (const chunk of bytes) {
    size += chunk.length
    if (size > MAX_DSH_LOG_SOURCE_BYTES) {
      throw new Error('DSH log exceeds the compressed source read limit')
    }
    yield chunk
  }
}
