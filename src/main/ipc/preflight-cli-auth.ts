import type { CliAuthState } from '../../shared/cli-auth-status'
import type { PreflightCommandResult } from './preflight-command-exec'

export type CliAuthProbeResult = {
  authenticated: boolean
  authState: CliAuthState
}

export type CliAuthCommandRunner = (args: string[]) => Promise<PreflightCommandResult>

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN'
])

/**
 * Build a consistent authentication probe result.
 *
 * @param authState Classified CLI authentication outcome.
 * @returns Boolean compatibility field plus the richer state.
 */
function authProbeResult(authState: CliAuthState): CliAuthProbeResult {
  return {
    authenticated: authState === 'authenticated',
    authState
  }
}

/**
 * Collect stdout, stderr, and message text from an exec rejection.
 *
 * @param error Rejected child-process error.
 * @returns Combined diagnostic text without logging credentials.
 */
function authErrorOutput(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const stdout = typeof record.stdout === 'string' ? record.stdout : ''
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  return `${stdout}\n${stderr}\n${message}`
}

/**
 * Read a child-process error code when one is present.
 *
 * @param error Rejected child-process error.
 * @returns Normalized code or an empty string.
 */
function authErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return ''
  }
  return String((error as { code?: unknown }).code ?? '').toUpperCase()
}

/**
 * Classify a failed CLI authentication command without treating every failure as logout.
 *
 * @param error Rejected child-process error.
 * @returns Timeout, reachability, authentication, or execution-error state.
 */
function classifyAuthFailure(error: unknown): CliAuthProbeResult {
  const code = authErrorCode(error)
  const output = authErrorOutput(error)
  if (code === 'ETIMEDOUT' || /\b(?:timed out|timeout)\b/i.test(output)) {
    return authProbeResult('timeout')
  }
  if (
    NETWORK_ERROR_CODES.has(code) ||
    /network is unreachable|no such host|could not resolve|temporary failure in name resolution|connection (?:refused|reset)|failed to connect|error connecting|proxyconnect tcp|tls handshake/i.test(
      output
    )
  ) {
    return authProbeResult('unreachable')
  }
  if (
    /not logged (?:in|into)|not authenticated|authentication failed|authentication required|bad credentials|http 401|no token|invalid token|token (?:is )?(?:invalid|expired)|run (?:gh|glab) auth login/i.test(
      output
    )
  ) {
    return authProbeResult('unauthenticated')
  }
  return authProbeResult('error')
}

/**
 * Conservatively classify plain-text gh failures from versions without JSON status.
 *
 * @param error Rejected legacy gh status command.
 * @returns Definite logout/reachability state, or a generic execution error.
 */
function classifyUnstructuredGhAuthFailure(error: unknown): CliAuthProbeResult {
  const classified = classifyAuthFailure(error)
  if (classified.authState === 'timeout' || classified.authState === 'unreachable') {
    return classified
  }
  // Why: older gh versions collapse invalid credentials and several network
  // failures into the same "invalid token"/"authentication failed" text.
  // Only the no-host/no-token cases prove that login is actually required.
  return /not logged into any github hosts|no (?:authentication )?token found/i.test(
    authErrorOutput(error)
  )
    ? authProbeResult('unauthenticated')
    : authProbeResult('error')
}

/**
 * Parse `gh auth status --json hosts` without requesting or exposing tokens.
 *
 * @param stdout Structured gh output.
 * @returns Classified result, or null when output is not valid status JSON.
 */
function parseGhAuthStatusJson(stdout: string): CliAuthProbeResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !('hosts' in parsed)) {
    return null
  }
  const hosts = (parsed as { hosts?: unknown }).hosts
  if (!hosts || typeof hosts !== 'object') {
    return authProbeResult('unauthenticated')
  }
  const accounts = Object.values(hosts)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter(
      (account): account is Record<string, unknown> =>
        account !== null &&
        typeof account === 'object' &&
        (account as { active?: unknown }).active === true
    )
  if (accounts.length === 0) {
    return authProbeResult('unauthenticated')
  }
  if (accounts.every((account) => account.state === 'success')) {
    return authProbeResult('authenticated')
  }
  if (accounts.some((account) => account.state === 'timeout')) {
    return authProbeResult('timeout')
  }
  const errorOutput = accounts
    .map((account) => (typeof account.error === 'string' ? account.error : ''))
    .filter(Boolean)
    .join('\n')
  const classifiedError = classifyAuthFailure(
    new Error(errorOutput || 'GitHub CLI returned an unknown authentication state')
  )
  return classifiedError
}

/**
 * Detect success markers emitted by older plain-text gh versions.
 *
 * @param output Combined CLI output.
 * @returns True when output identifies an active logged-in account.
 */
function hasLegacyGhSuccessMarker(output: string): boolean {
  return output.includes('Logged in') || output.includes('Active account: true')
}

/**
 * Detect a gh version that does not support the structured active-account probe.
 *
 * @param error Rejected structured-status command.
 * @returns True only when an active/JSON probe argument is unsupported.
 */
function isGhStructuredStatusUnsupported(error: unknown): boolean {
  const output = authErrorOutput(error)
  return /unknown (?:flag|option).*(?:--active|--json)|unknown json field|invalid value.*hosts/i.test(
    output
  )
}

/**
 * Probe GitHub CLI authentication with structured output and a legacy fallback.
 *
 * @param run Command runner scoped to the selected local or WSL runtime.
 * @returns Classified GitHub CLI authentication state.
 */
export async function probeGhAuthentication(
  run: CliAuthCommandRunner
): Promise<CliAuthProbeResult> {
  try {
    const result = await run(['auth', 'status', '--active', '--json', 'hosts'])
    const parsed = parseGhAuthStatusJson(result.stdout)
    if (parsed) {
      return parsed
    }
    return hasLegacyGhSuccessMarker(`${result.stdout}\n${result.stderr}`)
      ? authProbeResult('authenticated')
      : authProbeResult('error')
  } catch (error) {
    const parsed = parseGhAuthStatusJson(
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout ?? '')
        : ''
    )
    if (parsed) {
      return parsed
    }
    if (hasLegacyGhSuccessMarker(authErrorOutput(error))) {
      return authProbeResult('authenticated')
    }
    if (!isGhStructuredStatusUnsupported(error)) {
      return classifyUnstructuredGhAuthFailure(error)
    }
  }

  try {
    await run(['auth', 'status'])
    return authProbeResult('authenticated')
  } catch (error) {
    return hasLegacyGhSuccessMarker(authErrorOutput(error))
      ? authProbeResult('authenticated')
      : classifyUnstructuredGhAuthFailure(error)
  }
}

/**
 * Probe GitLab CLI authentication while preserving network and execution failures.
 *
 * @param run Command runner scoped to the selected local or WSL runtime.
 * @returns Classified GitLab CLI authentication state.
 */
export async function probeGlabAuthentication(
  run: CliAuthCommandRunner
): Promise<CliAuthProbeResult> {
  try {
    await run(['auth', 'status'])
    return authProbeResult('authenticated')
  } catch (error) {
    return authErrorOutput(error).includes('Logged in')
      ? authProbeResult('authenticated')
      : classifyAuthFailure(error)
  }
}
