import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HulyConnection } from '../../shared/types'

const execFileAsync = promisify(execFile)

// Why: a single `huly --version` and `huly whoami --json` is fast (~200ms), and
// the renderer should not run the CLI itself. All spawning happens on the Orca
// server process, which is either the user's local machine or the remote host
// they connected to via `orca serve`.

export type HulyCliEnv = {
  HULY_URL: string
  HULY_WORKSPACE: string
  HULY_NONINTERACTIVE: '1'
  HULY_EMAIL?: string
  HULY_PASSWORD?: string
  HULY_TOKEN?: string
}

export type HulyExecResult = { stdout: string; stderr: string }

export type HulyExecFn = (
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined>; timeout?: number; signal?: AbortSignal }
) => Promise<HulyExecResult>

export type HulyCliOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** Override the exec implementation — used by tests to avoid spawning a real process. */
  exec?: HulyExecFn
}

export class HulyCliError extends Error {
  readonly exitCode: number | null
  readonly stderr: string
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message)
    this.name = 'HulyCliError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export class HulyCliMissingError extends Error {
  constructor() {
    super(
      'The `huly` CLI is not installed on PATH. Install it with `npm i -g @iamcoder18/huly-cli`.'
    )
    this.name = 'HulyCliMissingError'
  }
}

export class HulyCliAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HulyCliAuthError'
  }
}

// Why: buildEnv was extracted as a helper but the runHulyCli path now inlines
// its work to keep env construction co-located with the precedence logic.
// The function is kept here in case future callers need a precomputed env.
function buildEnv(connection: HulyConnection): HulyCliEnv {
  const env: HulyCliEnv = {
    HULY_URL: connection.url,
    HULY_WORKSPACE: connection.workspace,
    HULY_NONINTERACTIVE: '1'
  }
  if (connection.email) {
    env.HULY_EMAIL = connection.email
  }
  env.HULY_TOKEN = ''
  env.HULY_PASSWORD = ''
  return env
}

void buildEnv

function parseJsonOrThrow<T>(stdout: string): T {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new HulyCliError('huly CLI returned empty output', 0, stdout)
  }
  try {
    return JSON.parse(trimmed) as T
  } catch (error) {
    throw new HulyCliError(
      `Failed to parse huly CLI JSON output: ${error instanceof Error ? error.message : 'unknown'}`,
      0,
      stdout
    )
  }
}

function classifyError(stderr: string, exitCode: number | null): Error {
  const message = stderr.trim() || 'huly CLI failed'
  if (/unauthori[sz]ed|invalid (?:token|password|credentials)/i.test(stderr)) {
    return new HulyCliAuthError(message)
  }
  return new HulyCliError(message, exitCode, stderr)
}

const defaultExec: HulyExecFn = async (file, args, options) => {
  return execFileAsync(file, args, {
    env: options.env as NodeJS.ProcessEnv,
    timeout: options.timeout,
    signal: options.signal,
    maxBuffer: 32 * 1024 * 1024
  })
}

// Why: huly CLI is invoked with --json --ci for stable output. --json returns a
// machine-parseable response and --ci suppresses prompts.
export async function runHulyCli<T = unknown>(
  connection: HulyConnection,
  password: string | null,
  token: string | null,
  args: string[],
  options: HulyCliOptions = {}
): Promise<T> {
  // Why: wipe inherited Huly auth vars first. process.env may carry HULY_TOKEN
  // or HULY_PASSWORD from an earlier connection in the same process; without
  // this, the CLI could authenticate as the wrong Huly workspace.
  const env: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
    HULY_URL: connection.url,
    HULY_WORKSPACE: connection.workspace,
    HULY_NONINTERACTIVE: '1',
    HULY_TOKEN: '',
    HULY_PASSWORD: '',
    HULY_EMAIL: ''
  }
  if (connection.email) {
    env.HULY_EMAIL = connection.email
  }
  if (token) {
    env.HULY_TOKEN = token
  } else if (password) {
    env.HULY_PASSWORD = password
  }

  const fullArgs = ['--json', '--ci', ...args]
  const exec = options.exec ?? defaultExec

  try {
    const { stdout } = await exec('huly', fullArgs, {
      env,
      timeout: options.timeoutMs ?? 60_000,
      signal: options.signal
    })
    return parseJsonOrThrow<T>(stdout)
  } catch (error) {
    if (error instanceof HulyCliError) {
      throw error
    }
    const execError = error as NodeJS.ErrnoException & {
      code?: string
      stderr?: string
      stdout?: string
    }
    if (execError.code === 'ENOENT') {
      throw new HulyCliMissingError()
    }
    throw classifyError(execError.stderr ?? '', execError.code === 'ENOENT' ? null : 1)
  }
}

// Why: preflight is intentionally separate so the renderer can call it without
// decrypting any token. The result feeds the Settings → Tasks wizard copy.
export type HulyPreflight = {
  installed: boolean
  version?: string
  authenticated: boolean
  accountEmail?: string
  error?: string
}

export async function preflightHulyCli(options: HulyCliOptions = {}): Promise<HulyPreflight> {
  const exec = options.exec ?? defaultExec
  try {
    const { stdout } = await exec('huly', ['--version'], {
      env: process.env as Record<string, string | undefined>,
      timeout: 5000
    })
    const version = stdout.trim().split('\n')[0] ?? ''
    try {
      const whoami = await exec('huly', ['--json', '--ci', 'whoami'], {
        env: process.env as Record<string, string | undefined>,
        timeout: 5000
      })
      const identity = parseIdentity(whoami.stdout)
      return {
        installed: true,
        version,
        authenticated: Boolean(identity?.email),
        accountEmail: identity?.email
      }
    } catch {
      return { installed: true, version, authenticated: false }
    }
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { code?: string }
    if (execError.code === 'ENOENT') {
      return { installed: false, authenticated: false }
    }
    return {
      installed: false,
      authenticated: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

function parseIdentity(stdout: string): { email?: string } | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as { email?: unknown }
    return typeof parsed.email === 'string' ? { email: parsed.email } : null
  } catch {
    return null
  }
}
