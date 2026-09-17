import { runProcess } from '../shared/child-process/run-process'
import type { ProcessResult, ProcessSpec } from '../shared/child-process/process-spec'
import { RuntimeClientError } from './runtime/types'

/**
 * Resolve a password-manager reference such as `op://vault/item/password` to
 * the secret it names, by asking the vendor CLI for it.
 *
 * Why a reference instead of the value: `--value "$(op read ...)"` puts the
 * secret in the argv of the CLI process, where every other process on the box
 * can read it. The reference is not sensitive, so it is safe in argv, in shell
 * history, and in an agent's transcript; only this process ever holds the
 * secret, and it goes straight to the runtime without being printed.
 */

export type SecretRefCommand = {
  program: string
  args: string[]
}

// A vendor CLI installed somewhere off PATH (or as a Windows `.cmd` shim, which
// needs its real path) is named here instead.
const PROGRAM_OVERRIDE_ENV: Record<string, string> = {
  op: 'ORCA_OP_CLI',
  bw: 'ORCA_BW_CLI'
}

const BITWARDEN_FIELDS = new Set(['password', 'username', 'totp'])

const SECRET_LOOKUP_TIMEOUT_MS = 120_000

function invalidRef(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function assertUsableSegments(segments: string[], ref: string): void {
  for (const segment of segments) {
    if (segment.length === 0) {
      throw invalidRef(`Invalid secret ref ${ref}: empty path segment`)
    }
    // Nothing is shell-interpreted here, but a leading dash would still be read
    // by the vendor CLI as one of its own options.
    if (segment.startsWith('-')) {
      throw invalidRef(`Invalid secret ref ${ref}: path segment may not start with "-"`)
    }
  }
}

function resolveProgram(program: string, env: NodeJS.ProcessEnv): string {
  const override = env[PROGRAM_OVERRIDE_ENV[program] ?? '']
  return override !== undefined && override.length > 0 ? override : program
}

export function buildSecretRefCommand(
  ref: string,
  env: NodeJS.ProcessEnv = process.env
): SecretRefCommand {
  if (ref.startsWith('op://')) {
    const segments = ref.slice('op://'.length).split('/')
    if (segments.length < 3) {
      throw invalidRef(`Invalid secret ref ${ref}: expected op://<vault>/<item>/<field>`)
    }
    assertUsableSegments(segments, ref)
    return { program: resolveProgram('op', env), args: ['read', '--no-newline', ref] }
  }
  if (ref.startsWith('bw://')) {
    const segments = ref.slice('bw://'.length).split('/')
    if (segments.length > 2) {
      throw invalidRef(`Invalid secret ref ${ref}: expected bw://<item>[/<field>]`)
    }
    assertUsableSegments(segments, ref)
    const [item, field = 'password'] = segments
    if (!BITWARDEN_FIELDS.has(field)) {
      throw invalidRef(
        `Invalid secret ref ${ref}: field must be one of ${[...BITWARDEN_FIELDS].join(', ')}`
      )
    }
    return { program: resolveProgram('bw', env), args: ['get', field, item] }
  }
  throw invalidRef(`Unsupported secret ref ${ref}: expected op:// or bw://`)
}

function lookupFailure(ref: string, program: string, result: ProcessResult): RuntimeClientError {
  // Only stderr is quoted: stdout is the secret whenever the CLI produced one.
  const detail = result.stderr
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()
  // A timeout resolves with a null code, so naming it keeps an unlocked-vault
  // prompt that nobody answered distinguishable from a crashed CLI.
  const cause = result.timedOut
    ? `${program} timed out after ${SECRET_LOOKUP_TIMEOUT_MS / 1000}s — the vault may be locked and waiting for input`
    : `${program} exited ${result.code ?? 'without a code'}`
  return new RuntimeClientError(
    'secret_ref_lookup_failed',
    `Secret lookup for ${ref} failed (${cause})${detail === undefined ? '' : `: ${detail}`}`
  )
}

export async function resolveSecretRef(
  ref: string,
  options: {
    env?: NodeJS.ProcessEnv
    run?: (spec: ProcessSpec) => Promise<ProcessResult>
  } = {}
): Promise<string> {
  const env = options.env ?? process.env
  const run = options.run ?? runProcess
  const command = buildSecretRefCommand(ref, env)
  let result: ProcessResult
  try {
    result = await run({
      program: command.program,
      args: command.args,
      env,
      timeoutMs: SECRET_LOOKUP_TIMEOUT_MS
    })
  } catch (error) {
    throw new RuntimeClientError(
      'secret_ref_lookup_failed',
      `Secret lookup for ${ref} could not start ${command.program}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (result.timedOut || result.code !== 0) {
    throw lookupFailure(ref, command.program, result)
  }
  const secret = result.stdout.replace(/\r?\n$/, '')
  if (secret.length === 0) {
    throw new RuntimeClientError(
      'secret_ref_lookup_failed',
      `Secret lookup for ${ref} returned an empty value`
    )
  }
  return secret
}
