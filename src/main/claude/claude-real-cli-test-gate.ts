import { parseClaudeAuthStatusReport } from './claude-auth-status-report'

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
  const report = parseClaudeAuthStatusReport(stdout)
  if (!report) {
    return null
  }
  const status: RealClaudeAuthStatus = {}
  if (report.loggedIn !== undefined) {
    status.loggedIn = report.loggedIn
  }
  if (report.projectsDirectory !== undefined) {
    status.projectsDirectory = report.projectsDirectory
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
