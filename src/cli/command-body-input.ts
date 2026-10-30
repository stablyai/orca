import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getRequiredStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'
import { RuntimeClientError } from './runtime-client'

type BodyOptions = {
  required: boolean
  maximumCharacters: number
  tooLargeCode: string
  label: string
}

export function readCommandBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: BodyOptions & { required: true }
): Promise<string>
export function readCommandBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: BodyOptions
): Promise<string | undefined>
export async function readCommandBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: BodyOptions
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
    : await readBodyFile(getRequiredStringFlag(flags, 'body-file'), cwd, options)
  if (body.length > options.maximumCharacters) {
    throw bodyTooLarge(options)
  }
  return body
}

function bodyTooLarge(options: BodyOptions): RuntimeClientError {
  return new RuntimeClientError(
    options.tooLargeCode,
    `${options.label} must be at most ${options.maximumCharacters} characters`
  )
}

async function readBodyFile(path: string, cwd: string, options: BodyOptions): Promise<string> {
  // Why: UTF-8 spends at most 4 bytes per character, so more bytes than this must be over the cap.
  const maxBytes = options.maximumCharacters * 4
  if (path !== '-') {
    const filePath = isAbsolute(path) ? path : join(cwd, path)
    if ((await stat(filePath)).size > maxBytes) {
      throw bodyTooLarge(options)
    }
    return readFile(filePath, 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin body requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > maxBytes) {
      throw bodyTooLarge(options)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
