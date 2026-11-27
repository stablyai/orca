import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolveCallerLocalPath } from '../../shared/file-access/caller-local-path'
import { getWslCallerDistro } from '../hosts/wsl-caller-distro'
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
    const wslDistro = getWslCallerDistro(cwd)
    const isWslAbsolute = Boolean(wslDistro && path.startsWith('/') && !path.startsWith('//'))
    // Keep native absolute paths unnormalized so symlinks before `..` resolve via the OS;
    // a WSL caller's Linux path still translates to a distro UNC or drive path.
    const resolved =
      !isWslAbsolute && isAbsolute(path) ? path : resolveCallerLocalPath(path, cwd, wslDistro)
    try {
      return await readFile(resolved, 'utf8')
    } catch (error) {
      const reason = error instanceof Error && 'code' in error ? String(error.code) : String(error)
      throw new RuntimeClientError('invalid_argument', `Could not read ${resolved}: ${reason}`)
    }
  }
  return readStdin('body')
}
