import { RuntimeClientError } from './runtime-client'

export async function readStdinPayload(maxBytes?: number): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin payload requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (maxBytes !== undefined && bytes > maxBytes) {
      throw new RuntimeClientError(
        'invalid_argument',
        `stdin payload exceeds the ${maxBytes}-byte input limit`
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
