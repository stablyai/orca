/** Opt-in for tests that drive the real `claude` CLI on this machine's signed-in account. */
export const REAL_CLAUDE_CLI_TEST_ENV = 'ORCA_REAL_CLAUDE_CLI_TEST'

export type ClaudeCliProbeResult = { status: number | null; stdout: string }

export type RealClaudeAuthStatus = { loggedIn?: boolean; projectsDirectory?: string }

export type RealClaudeCliGate = {
  /** Null permits the real-CLI suite to run. */
  skipReason: string | null
  authStatus: RealClaudeAuthStatus | null
}

function parseAuthStatus(stdout: string): RealClaudeAuthStatus | null {
  const start = stdout.search(/[[{]/)
  if (start === -1) {
    return null
  }
  // CLI warnings may precede the report, but another JSON value makes it ambiguous.
  for (const line of stdout.slice(0, start).split('\n')) {
    try {
      JSON.parse(line)
      return null
    } catch {
      continue
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const status: RealClaudeAuthStatus = {}
  if ('loggedIn' in parsed && typeof parsed.loggedIn === 'boolean') {
    status.loggedIn = parsed.loggedIn
  }
  if ('projectsDirectory' in parsed && typeof parsed.projectsDirectory === 'string') {
    status.projectsDirectory = parsed.projectsDirectory
  }
  return status
}

export function resolveRealClaudeCliGate(
  env: NodeJS.ProcessEnv,
  runClaude: (args: readonly string[]) => ClaudeCliProbeResult
): RealClaudeCliGate {
  // Require opt-in before probing an account whose tests spend turns and write transcripts.
  if (env[REAL_CLAUDE_CLI_TEST_ENV] !== '1') {
    return {
      skipReason: `set ${REAL_CLAUDE_CLI_TEST_ENV}=1 to run against the real claude CLI`,
      authStatus: null
    }
  }
  if (runClaude(['--version']).status !== 0) {
    return { skipReason: '`claude --version` failed', authStatus: null }
  }
  const auth = runClaude(['auth', 'status', '--json'])
  return { skipReason: null, authStatus: auth.status === 0 ? parseAuthStatus(auth.stdout) : null }
}
