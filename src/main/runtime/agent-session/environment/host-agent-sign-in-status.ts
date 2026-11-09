import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type {
  HostAgentSignInAgent,
  HostAgentSignInEntry,
  HostAgentSignInReport
} from '../../../../shared/host-agent-sign-in-status'
import { parseClaudeAuthStatusReport } from '../../../claude/claude-auth-status-report'
import {
  execLocalPreflightCommandOrThrow,
  findRunnableLocalCommand,
  type LocalCommandProbe
} from '../../../ipc/preflight-command-exec'

// Why: clients ask on open and after a sign-in; one minute keeps reopened views from respawning CLIs.
const REPORT_TTL_MS = 60_000
const STATUS_TIMEOUT_MS = 10_000

export type AgentStatusCommandResult = {
  exitCode: number | null
  output: string
  timedOut: boolean
}

export type HostAgentSignInStatusDeps = {
  findCommand: (command: string) => Promise<LocalCommandProbe>
  runStatus: (binary: string, args: string[]) => Promise<AgentStatusCommandResult>
  /** This host's Orca account roster; null where it has none. */
  readAccounts: () => {
    claude: ClaudeRateLimitAccountsState
    codex: CodexRateLimitAccountsState
  } | null
  now: () => number
}

type Accounts = NonNullable<ReturnType<HostAgentSignInStatusDeps['readAccounts']>>

const STATUS_ARGS: Record<HostAgentSignInAgent, string[]> = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status']
}

export function hostSelection(state: {
  activeAccountId: string | null
  activeAccountIdsByRuntime?: { host: string | null }
}): string | null {
  return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId
}

/** The verdict a selected Orca account fixes for launches here; null leaves it to the CLI's own login. */
function orcaAccountVerdict(
  agent: HostAgentSignInAgent,
  accounts: Accounts | null
): 'signedIn' | 'signedOut' | null {
  if (!accounts) {
    return null
  }
  if (agent === 'claude') {
    const id = hostSelection(accounts.claude)
    const account = accounts.claude.accounts.find((entry) => entry.id === id)
    if (!account || account.runsOnSystemDefault) {
      return null
    }
    // Launches use the account's own folder, which holds no login yet.
    return account.needsSignIn ? 'signedOut' : 'signedIn'
  }
  const id = hostSelection(accounts.codex)
  return accounts.codex.accounts.some((entry) => entry.id === id) ? 'signedIn' : null
}

export function classifyAgentStatusOutput(
  agent: HostAgentSignInAgent,
  result: AgentStatusCommandResult
): HostAgentSignInEntry {
  if (result.timedOut) {
    return { agent, state: 'unknown' }
  }
  if (agent === 'claude') {
    // Signed out exits 1 with the same JSON report.
    const report = parseClaudeAuthStatusReport(result.output)
    if (report?.loggedIn === true) {
      const apiKey = report.authMethod === 'api_key' || report.apiKeySource !== undefined
      return { agent, state: 'signedIn', method: apiKey ? 'apiKey' : 'cliLogin' }
    }
    return { agent, state: report?.loggedIn === false ? 'signedOut' : 'unknown' }
  }
  // Codex prints its verdict to stderr on some versions; the exit code is the contract.
  if (result.exitCode === 0) {
    return {
      agent,
      state: 'signedIn',
      method: /api key/i.test(result.output) ? 'apiKey' : 'cliLogin'
    }
  }
  return { agent, state: /not logged in/i.test(result.output) ? 'signedOut' : 'unknown' }
}

/** Checks, on this host, whether each agent CLI would start signed in. Results are cached and
 *  concurrent asks share one check, so opening many views never fans out CLI spawns. */
export class HostAgentSignInStatusChecker {
  private report: HostAgentSignInReport | null = null
  private inFlight: Promise<HostAgentSignInReport> | null = null
  private queuedForce: Promise<HostAgentSignInReport> | null = null

  constructor(private readonly deps: HostAgentSignInStatusDeps) {}

  read(force = false): Promise<HostAgentSignInReport> {
    if (this.inFlight) {
      if (!force) {
        return this.inFlight
      }
      // Why: a check begun before a sign-in finished can't answer a forced recheck after it.
      this.queuedForce ??= this.inFlight
        .catch(() => undefined)
        .then(() => {
          this.queuedForce = null
          return this.start()
        })
      return this.queuedForce
    }
    const cached = this.report
    if (!force && cached && this.deps.now() - cached.checkedAt < REPORT_TTL_MS) {
      return Promise.resolve(cached)
    }
    return this.start()
  }

  private start(): Promise<HostAgentSignInReport> {
    const run = this.check().finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null
      }
    })
    this.inFlight = run
    return run
  }

  private async check(): Promise<HostAgentSignInReport> {
    let accounts: Accounts | null = null
    try {
      accounts = this.deps.readAccounts()
    } catch {
      // An unreadable roster leaves the CLI's own login to decide.
    }
    const agents = await Promise.all(
      (['claude', 'codex'] as const).map((agent) => this.checkAgent(agent, accounts))
    )
    const report = { checkedAt: this.deps.now(), agents }
    this.report = report
    return report
  }

  private async checkAgent(
    agent: HostAgentSignInAgent,
    accounts: Accounts | null
  ): Promise<HostAgentSignInEntry> {
    const probe = await this.deps.findCommand(agent)
    if (probe.status === 'absent') {
      return { agent, state: 'notInstalled' }
    }
    if (probe.status !== 'available') {
      return { agent, state: 'unknown' }
    }
    const verdict = orcaAccountVerdict(agent, accounts)
    if (verdict) {
      return verdict === 'signedIn'
        ? { agent, state: 'signedIn', method: 'orcaAccount' }
        : { agent, state: 'signedOut' }
    }
    try {
      return classifyAgentStatusOutput(
        agent,
        await this.deps.runStatus(probe.binary, STATUS_ARGS[agent])
      )
    } catch {
      return { agent, state: 'unknown' }
    }
  }
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null
    ? Object.getOwnPropertyDescriptor(error, field)?.value
    : undefined
}

/** Runs a status verb; its output is classified here and never leaves the host. */
export async function runAgentStatusCommand(
  binary: string,
  args: string[]
): Promise<AgentStatusCommandResult> {
  try {
    const { stdout, stderr } = await execLocalPreflightCommandOrThrow(binary, args, {
      timeoutMs: STATUS_TIMEOUT_MS
    })
    return { exitCode: 0, output: `${stdout}\n${stderr}`, timedOut: false }
  } catch (error) {
    const code = errorField(error, 'code')
    const stdout = errorField(error, 'stdout')
    const stderr = errorField(error, 'stderr')
    return {
      // Why: a throw carrying code 0 is truncated output, never a clean exit.
      exitCode: typeof code === 'number' && code !== 0 ? code : null,
      output: `${typeof stdout === 'string' ? stdout : ''}\n${typeof stderr === 'string' ? stderr : ''}`,
      timedOut: code === 'ETIMEDOUT' || errorField(error, 'killed') === true
    }
  }
}

const LOGOUT_ARGS: Record<HostAgentSignInAgent, string[]> = {
  claude: ['auth', 'logout'],
  codex: ['logout']
}

/** Signs the CLI's own login on this host out; the CLI deletes its credentials itself. */
export async function runAgentLogoutCommand(agent: HostAgentSignInAgent): Promise<void> {
  const name = agent === 'claude' ? 'Claude' : 'Codex'
  const probe = await findRunnableLocalCommand(agent)
  if (probe.status !== 'available') {
    throw new Error(`${name} is not installed on this host.`)
  }
  const result = await runAgentStatusCommand(probe.binary, LOGOUT_ARGS[agent])
  if (result.exitCode !== 0) {
    throw new Error(`${name} could not sign out on this host.`)
  }
}

export function createHostAgentSignInStatusChecker(
  readAccounts: HostAgentSignInStatusDeps['readAccounts']
): HostAgentSignInStatusChecker {
  return new HostAgentSignInStatusChecker({
    findCommand: findRunnableLocalCommand,
    runStatus: runAgentStatusCommand,
    readAccounts,
    now: Date.now
  })
}
