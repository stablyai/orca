import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findOptionOccurrence } from '../../shared/command-option-occurrence'
import { getCommandTokenPathBasename } from '../../shared/command-token-scanner'
import { MANAGED_DATA_ACCOUNT_RESUME_ENV } from '../../shared/managed-data-account-resume'
import { findOpenCodeRunCommand } from '../../shared/opencode-headless-command'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import { managedAccountLaunchEnvironment } from '../managed-data-accounts/launch-environment'
import { getManagedDataAccountService } from '../managed-data-accounts/service'

const OPENCODE_EXECUTABLE = /^opencode2?(\.(exe|cmd))?$/i

// Why: concurrent launches register ~1s after spawn; hold the port for the first one meanwhile.
const CLAIM_MS = 30_000
let sharedServiceClaim: { stateHome: string; expires: number } | undefined

function stateHome(env: Record<string, string | undefined>): string {
  return env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
}

// Upstream's discovery contract names the live pid; sync keeps the claim check atomic.
function hasLiveService(home: string): boolean {
  let pid: unknown
  try {
    pid = JSON.parse(readFileSync(join(home, 'opencode', 'service.json'), 'utf8'))?.pid
  } catch {
    return false
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** OpenCode 2's background service binds one fixed port; another data dir's live service means ours cannot start. */
export function needsOpenCodePrivateServer(env: Record<string, string>): boolean {
  const service = getManagedDataAccountService()
  const accounts = service.transcriptEnvironments('opencode')
  if (accounts.length === 0) {
    return false
  }
  const original: Record<string, string | undefined> = { ...env }
  service.restoreOriginalEnvironment(original)
  const userState = stateHome(original)
  // Daemon spawns already resolved (and consumed) the resume request into the env.
  const own =
    (env.ORCA_DATA_ACCOUNT_PROVIDER === 'opencode' && env.ORCA_DATA_ACCOUNT_STATE_HOME) ||
    managedAccountLaunchEnvironment(service, 'opencode', env[MANAGED_DATA_ACCOUNT_RESUME_ENV])
      .XDG_STATE_HOME ||
    userState
  if (hasLiveService(own)) {
    return false
  }
  const others = new Set([userState, ...accounts.map((account) => account.XDG_STATE_HOME)])
  others.delete(own)
  const claim = sharedServiceClaim
  if (
    [...others].some((home) => home && hasLiveService(home)) ||
    (claim && claim.stateHome !== own && Date.now() < claim.expires)
  ) {
    return true
  }
  sharedServiceClaim = { stateHome: own, expires: Date.now() + CLAIM_MS }
  return false
}

export function resetOpenCodeSharedServiceClaimForTests(): void {
  sharedServiceClaim = undefined
}

/** OpenCode 2's one-port background service serves one data dir; a private server picks its own port. */
export function withOpenCodeStandaloneServer(command: string, shell: AgentStartupShell): string {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok || findOptionOccurrence(parsed.tokens, ['--standalone', '--server'], true)) {
    return command
  }
  const { tokens, spans } = parsed
  const executable = shell === 'powershell' && tokens[0] === '&' ? 1 : 0
  if (!OPENCODE_EXECUTABLE.test(getCommandTokenPathBasename(tokens[executable] ?? ''))) {
    return command
  }
  const run = findOpenCodeRunCommand(tokens, shell)
  const next = tokens[executable + 1]
  // Skip other positionals: OpenCode rejects `opencode --standalone session ...`.
  const anchor = run ? run.runIndex : next === undefined || next.startsWith('-') ? executable : -1
  const span = spans[anchor]
  if (!span || span.divergesFromShell) {
    return command
  }
  return `${command.slice(0, span.end)} --standalone${command.slice(span.end)}`
}
