import { readFileSync } from 'node:fs'
import { RuntimeClientError } from './types'

export type PairingCodeInputArgs = {
  positional?: string
  flags: ReadonlyMap<string, string | boolean>
  // Injectable so tests never need a real stdin.
  readStdin?: () => Promise<string>
}

/**
 * Resolves the pairing code from exactly one source: positional, --pairing-code,
 * --pairing-code-file, or `--pairing-code -` (stdin). Zero or multiple sources fail
 * so a typo can never silently pair the wrong code.
 */
export async function resolvePairingCodeInput(args: PairingCodeInputArgs): Promise<string> {
  const flagValue = args.flags.get('pairing-code')
  const positional = args.positional
  const codeFile = args.flags.get('pairing-code-file')
  const stdinRequested = typeof flagValue === 'string' && flagValue === '-'

  const sources = [
    positional !== undefined && positional.length > 0 ? 'positional argument' : null,
    typeof flagValue === 'string' && flagValue.length > 0 ? '--pairing-code' : null,
    typeof codeFile === 'string' && codeFile.length > 0 ? '--pairing-code-file' : null
  ].filter((source): source is string => source !== null)

  // Positional and --pairing-code are the same slot; both set counts as two sources.
  if (sources.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Provide the pairing code from exactly one source (got ${sources.join(' and ')}).`
    )
  }
  if (sources.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing pairing code: pass it as a positional argument, --pairing-code <code>, --pairing-code-file <path>, or --pairing-code - to read stdin.'
    )
  }

  if (stdinRequested) {
    const readStdin = args.readStdin ?? defaultReadStdin
    const code = (await readStdin()).trim()
    if (code.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Pairing code from stdin was empty.')
    }
    return code
  }
  if (typeof codeFile === 'string' && codeFile.length > 0) {
    let content: string
    try {
      content = readFileSync(codeFile, 'utf8')
    } catch {
      throw new RuntimeClientError(
        'invalid_argument',
        `Could not read pairing code file ${codeFile}.`
      )
    }
    const code = content.trim()
    if (code.length === 0) {
      throw new RuntimeClientError('invalid_argument', `Pairing code file ${codeFile} was empty.`)
    }
    return code
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: flag is declared string|boolean in the spec; the string case is what reaches this line (boolean flag means 'read stdin', handled above).
  return (positional ?? (flagValue as string)).trim()
}

function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      input += chunk
    })
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', reject)
  })
}

const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Parses a --ttl duration: plain integer = milliseconds, else `<n>ms|s|m|h|d`.
 * Positive and capped at 30 days.
 */
export function parseTtlMs(input: string): number {
  const trimmed = input.trim()
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(trimmed)
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --ttl "${input}". Use a duration like 30m, 24h, 7d, or a plain millisecond integer.`
    )
  }
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  }
  const value = Number(match[1])
  const ms = value * unitMs[match[2] ?? 'ms']
  if (ms <= 0 || !Number.isSafeInteger(ms)) {
    throw new RuntimeClientError('invalid_argument', `Invalid --ttl "${input}": must be positive.`)
  }
  if (ms > MAX_TTL_MS) {
    throw new RuntimeClientError('invalid_argument', `--ttl must be at most 30d.`)
  }
  return ms
}
