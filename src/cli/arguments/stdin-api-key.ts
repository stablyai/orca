import { RuntimeClientError } from '../runtime/connection/types'

/** Reads an API key piped on stdin, keeping it out of argv, shell history and process listings. */
export async function readApiKeyFromStdin(
  key: { name: string; pipeExample: string; maxLength: number },
  stdin: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin
): Promise<string> {
  if (stdin.isTTY) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Pipe the key on stdin, e.g. ${key.pipeExample}`
    )
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > key.maxLength * 4) {
      throw new RuntimeClientError('invalid_argument', `That is too long to be ${key.name}`)
    }
    chunks.push(buffer)
  }
  const value = Buffer.concat(chunks).toString('utf8').trim()
  if (!value) {
    throw new RuntimeClientError('invalid_argument', 'No key on stdin')
  }
  if (value.length > key.maxLength) {
    throw new RuntimeClientError('invalid_argument', `That is too long to be ${key.name}`)
  }
  // Keys have no inner whitespace; a provider would echo such a value back in its header error.
  if (/[\s\p{Cc}]/u.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `That is not ${key.name}: it has spaces or line breaks inside`
    )
  }
  return value
}
