import { CLIPBOARD_TEXT_WRITE_MAX_BYTES } from '../shared/clipboard-text'
import { getRequiredStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'
import { RuntimeClientError } from './runtime-client'

/**
 * Reads `--<name>` or, with `--<name>-stdin`, stdin minus one trailing newline. The stdin form keeps
 * secrets out of argv, where `ps` and shell history can see them.
 */
export async function getFlagOrStdinTextPayload(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowEmpty: boolean }
): Promise<string> {
  const stdinFlag = `${name}-stdin`
  if (flags.has(stdinFlag)) {
    if (typeof flags.get(stdinFlag) === 'string') {
      // Never echo the value: `--value-stdin=<secret>` already put it in argv.
      throw new RuntimeClientError(
        'invalid_argument',
        `--${stdinFlag} takes no value; pipe the ${name} on stdin`
      )
    }
    if (flags.has(name)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Use either --${name} or --${stdinFlag}, not both`
      )
    }
    // Why: secret readers (pass, op, PowerShell pipes) end with a newline the field should not get.
    const payload = trimOneTrailingNewline(
      await readStdinText('payload', {
        maxBytes: CLIPBOARD_TEXT_WRITE_MAX_BYTES,
        tooLargeMessage: `--${stdinFlag} input is too large`
      })
    )
    if (!options.allowEmpty && payload.length === 0) {
      throw new RuntimeClientError('invalid_argument', `Missing ${name} from stdin`)
    }
    return payload
  }
  if (!flags.has(name)) {
    throw new RuntimeClientError('invalid_argument', `Missing --${name} or --${stdinFlag}`)
  }
  return options.allowEmpty
    ? getRequiredStringFlagAllowingEmpty(flags, name)
    : getRequiredStringFlag(flags, name)
}

/** Reads all of stdin as UTF-8, refusing an interactive terminal so it never waits on typed input. */
export async function readStdinText(
  label: string,
  limit?: { maxBytes: number; tooLargeMessage: string }
): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', `stdin ${label} requested but stdin is a TTY`)
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (limit && bytes > limit.maxBytes) {
      throw new RuntimeClientError('invalid_argument', limit.tooLargeMessage)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function trimOneTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) {
    return text.slice(0, -2)
  }
  return text.endsWith('\n') ? text.slice(0, -1) : text
}
