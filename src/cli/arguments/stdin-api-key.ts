import { RuntimeClientError } from '../runtime/connection/types'
import { validateApiKey } from '../../shared/validation/api-key'

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
  try {
    return validateApiKey(value, { name: key.name, maxLength: key.maxLength })
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      error instanceof Error ? error.message : String(error)
    )
  }
}
