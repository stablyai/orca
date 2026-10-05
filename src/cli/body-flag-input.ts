import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getRequiredStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'
import { RuntimeClientError } from './runtime-client'

export type BodyFlagLimit = { maxChars: number; tooLarge: () => RuntimeClientError }

// Why: UTF-8 spends at most 4 bytes per character, so more bytes than this must be over the cap.
function maxBodyBytes(limit: BodyFlagLimit): number {
  return limit.maxChars * 4
}

async function readBodyFile(path: string, cwd: string, limit: BodyFlagLimit): Promise<string> {
  if (path !== '-') {
    const filePath = isAbsolute(path) ? path : join(cwd, path)
    if ((await stat(filePath)).size > maxBodyBytes(limit)) {
      throw limit.tooLarge()
    }
    return await readFile(filePath, 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin body requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > maxBodyBytes(limit)) {
      throw limit.tooLarge()
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Reads `--body` or `--body-file <path|->` (stdin), enforcing the caller's size limit. */
export async function readBodyFlags(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: boolean; limit: BodyFlagLimit }
): Promise<string | undefined> {
  const hasBody = flags.has('body')
  const hasBodyFile = flags.has('body-file')
  if (hasBody && hasBodyFile) {
    throw new RuntimeClientError('invalid_argument', 'Use either --body or --body-file, not both')
  }
  if (!hasBody && !hasBodyFile) {
    if (options.required) {
      throw new RuntimeClientError('invalid_argument', 'Missing --body or --body-file')
    }
    return undefined
  }
  const body = hasBody
    ? getRequiredStringFlagAllowingEmpty(flags, 'body')
    : await readBodyFile(getRequiredStringFlag(flags, 'body-file'), cwd, options.limit)
  if (body.length > options.limit.maxChars) {
    throw options.limit.tooLarge()
  }
  return body
}
