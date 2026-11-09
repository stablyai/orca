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

function hostSelection(state: {
  activeAccountId: string | null
  activeAccountIdsByRuntime?: { host: string | null }
}): string | null {
  return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId
}

/** Whether launches here already use a signed-in Orca account, so the CLI's own login is moot. */
function usesOrcaAccount(agent: HostAgentSignInAgent, accounts: Accounts | null): boolean {
  if (!accounts) {
    return false
  }
  if (agent === 'claude') {
    const id = hostSelection(accounts.claude)
    const account = accounts.claude.accounts.find((entry) => entry.id === id)
    return Boolean(account && !account.needsSignIn && !account.runsOnSystemDefault)
  }
  const id = hostSelection(accounts.codex)
  return accounts.codex.accounts.some((entry) => entry.id === id)
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

  constructor(private readonly deps: HostAgentSignInStatusDeps) {}

  read(force = false): Promise<HostAgentSignInReport> {
    if (this.inFlight) {
      return this.inFlight
    }
    const cached = this.report
    if (!force && cached && this.deps.now() - cached.checkedAt < REPORT_TTL_MS) {
      return Promise.resolve(cached)
    }
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
    if (usesOrcaAccount(agent, accounts)) {
      return { agent, state: 'signedIn', method: 'orcaAccount' }
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
  return typeof error === 'object' && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
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
      exitCode: typeof code === 'number' ? code : null,
      output: `${typeof stdout === 'string' ? stdout : ''}\n${typeof stderr === 'string' ? stderr : ''}`,
      timedOut: code === 'ETIMEDOUT' || errorField(error, 'killed') === true
    }
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
