import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { readStdin } from './flag-or-stdin-payload'
import { getRequiredStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'
import { RuntimeClientError } from '../runtime/connection/types'

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
  required: boolean
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
  return hasText
    ? getRequiredStringFlagAllowingEmpty(flags, flag)
    : readBodyFile(getRequiredStringFlag(flags, fileFlag), cwd)
}

async function readBodyFile(path: string, cwd: string): Promise<string> {
  if (path !== '-') {
    const resolved = isAbsolute(path) ? path : join(cwd, path)
    try {
      return await readFile(resolved, 'utf8')
    } catch (error) {
      const reason = error instanceof Error && 'code' in error ? String(error.code) : String(error)
      throw new RuntimeClientError('invalid_argument', `Could not read ${resolved}: ${reason}`)
    }
  }
  return readStdin('body')
}
