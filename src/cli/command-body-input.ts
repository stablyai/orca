import { readFile } from 'node:fs/promises'
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
    : await readBodyFile(getRequiredStringFlag(flags, 'body-file'), cwd)
  if (body.length > options.maximumCharacters) {
    throw new RuntimeClientError(
      options.tooLargeCode,
      `${options.label} must be at most ${options.maximumCharacters} characters`
    )
  }
  return body
}

async function readBodyFile(path: string, cwd: string): Promise<string> {
  if (path !== '-') {
    return readFile(isAbsolute(path) ? path : join(cwd, path), 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin body requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
