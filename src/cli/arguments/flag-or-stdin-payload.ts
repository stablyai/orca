import { getRequiredStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'
import { RuntimeClientError } from '../runtime/connection/types'

/** Reads `--<name>`, or stdin for `--<name>-stdin` so secrets stay out of argv and shell history. */
export async function getFlagOrStdinPayload(
  flags: Map<string, string | boolean>,
  name: 'text' | 'value',
  {
    allowEmptyStdin = false,
    trimTrailingNewline = false
  }: { allowEmptyStdin?: boolean; trimTrailingNewline?: boolean } = {}
): Promise<string> {
  const stdinFlag = `${name}-stdin`
  if (flags.has(stdinFlag)) {
    if (flags.has(name)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Use either --${name} or --${stdinFlag}, not both`
      )
    }
    const raw = await readStdin('payload')
    // Secret readers (`pass`, `op read`, `echo`) end with a newline that breaks number/date inputs.
    const payload = trimTrailingNewline ? raw.replace(/\r?\n$/, '') : raw
    // An empty pipe usually means the secret reader failed; don't silently clear the field.
    if (payload.length === 0 && !allowEmptyStdin) {
      throw new RuntimeClientError('invalid_argument', `Missing ${name} from stdin`)
    }
    return payload
  }
  return name === 'value'
    ? getRequiredStringFlagAllowingEmpty(flags, name)
    : getRequiredStringFlag(flags, name)
}

export async function readStdin(label: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', `stdin ${label} requested but stdin is a TTY`)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
