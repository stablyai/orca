import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getRequiredStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'
import { RuntimeClientError } from '../runtime/types'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/file-content/node-bounded-file-reader'

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
  const body = await readTextOrFileFlag(flags, cwd, 'body', options.required)
  if (body !== undefined && body.length > options.maximumCharacters) {
    throw new RuntimeClientError(
      options.tooLargeCode,
      `${options.label} must be at most ${options.maximumCharacters} characters`
    )
  }
  return body
}

/** Reads `--<flag> <text>` or `--<flag>-file <path|->`, refusing both. */
export async function readTextOrFileFlag(
  flags: Map<string, string | boolean>,
  cwd: string,
  flag: string,
  required: boolean,
  maximumBytes?: number
): Promise<string | undefined> {
  const fileFlag = `${flag}-file`
  const hasText = flags.has(flag)
  const hasFile = flags.has(fileFlag)
  if (hasText && hasFile) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Use either --${flag} or --${fileFlag}, not both`
    )
  }
  if (!hasText && !hasFile) {
    if (required) {
      throw new RuntimeClientError('invalid_argument', `Missing --${flag} or --${fileFlag}`)
    }
    return undefined
  }
  const text = hasText
    ? getRequiredStringFlagAllowingEmpty(flags, flag)
    : await readBodyFile(getRequiredStringFlag(flags, fileFlag), cwd, maximumBytes)
  if (maximumBytes !== undefined && Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw inputTooLarge()
  }
  return text
}

function inputTooLarge() {
  return new RuntimeClientError('invalid_argument', 'Input exceeds the byte limit.')
}

async function readBodyFile(path: string, cwd: string, maximumBytes?: number): Promise<string> {
  if (path !== '-') {
    const resolved = isAbsolute(path) ? path : join(cwd, path)
    if (maximumBytes === undefined) {
      return readFile(resolved, 'utf8')
    }
    try {
      return (
        await readNodeFileWithinLimit(resolved, maximumBytes, { regularFileOnly: true })
      ).buffer.toString('utf8')
    } catch (error) {
      if (error instanceof NodeFileReadTooLargeError) {
        throw inputTooLarge()
      }
      throw error
    }
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin body requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (maximumBytes !== undefined && bytes > maximumBytes) {
      throw inputTooLarge()
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
