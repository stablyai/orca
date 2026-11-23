import { runProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { processEnvWithoutAgentSession } from '../../shared/agent-launch/startup/parent-agent-session-env'

/**
 * `ORCA_AZURE_DEVOPS_TOKEN_COMMAND` names a command (a keychain or secret-tool lookup, like a git
 * credential helper) that prints the token. Orca runs it when it needs the token and keeps the
 * answer in memory only, so the secret is never in any process environment (#44365).
 */
export const AZURE_DEVOPS_TOKEN_COMMAND_ENV = 'ORCA_AZURE_DEVOPS_TOKEN_COMMAND'

const TOKEN_TTL_MS = 10 * 60_000
const COMMAND_TIMEOUT_MS = 15_000

let cached: { token: string; expiresAt: number } | null = null
let inFlight: Promise<string | null> | null = null

export function azureDevOpsTokenCommand(): string | null {
  const value = process.env[AZURE_DEVOPS_TOKEN_COMMAND_ENV]?.trim() ?? ''
  return value.length > 0 ? value : null
}

/** The token the command last printed, while it is fresh; synchronous readers use this. */
export function cachedAzureDevOpsCommandToken(now = Date.now()): string | null {
  return cached && cached.expiresAt > now ? cached.token : null
}

/** Runs a token command with no inherited credentials and returns its first non-empty line. */
export async function runAzureDevOpsTokenCommand(command: string): Promise<string | null> {
  const env = processEnvWithoutAgentSession()
  const shell =
    process.platform === 'win32'
      ? {
          program: windowsSystem32Binary('cmd.exe', env),
          args: ['/d', '/s', '/c', command],
          windowsVerbatimArguments: true
        }
      : { program: '/bin/sh', args: ['-c', command] }
  try {
    const result = await runProcess({
      ...shell,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    const token = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    return result.code === 0 && !result.timedOut && token ? token : null
  } catch {
    return null
  }
}

/** Refreshes the in-memory token from the configured command; a no-op without one. */
export async function ensureAzureDevOpsCommandToken(): Promise<string | null> {
  const command = azureDevOpsTokenCommand()
  if (!command) {
    return null
  }
  const fresh = cachedAzureDevOpsCommandToken()
  if (fresh) {
    return fresh
  }
  inFlight ??= runAzureDevOpsTokenCommand(command)
    .then((token) => {
      cached = token ? { token, expiresAt: Date.now() + TOKEN_TTL_MS } : null
      return token
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
