import { OrcaRuntimeWithClaudeRunningPaneAccountMove } from './claude-running-pane-account-move'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { readAgentPaneForeground } from './agent-pane-foreground-read'
import { AGY_HOST_SELECTION } from '../../../antigravity/agy-account-selection'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import type {
  AntigravityAccountSelectResult,
  AntigravityAccountSelectionChange
} from '../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

/** No saved account was selected as the terminal started, so agy ran on the login it held. */
const NO_ACCOUNT = ''

type AgyTerminal = {
  pty: RuntimePtyWorktreeRecord
  session: AgentProviderSessionMetadata | null
  /** The saved account it runs on. */
  account: string
}

export type AntigravityHostSwitch = {
  from: string | null
  to: string
  /** The window that switched restarts its own terminals; the host only lists them. */
  movesRunningSessions?: true
  /** The switching client's choice; absent, this host's setting decides. */
  runningSessions?: ClaudeAccountSwitchRunningSessions
}

/** agy keeps one login per host, so a switch leaves every agy already running in a terminal on the
 *  previous account until it restarts. A window restarts the ones it shows; a host without one
 *  restarts them itself. */
export abstract class OrcaRuntimeWithAntigravityRunningPaneAccountMove extends OrcaRuntimeWithClaudeRunningPaneAccountMove {
  /** The account each live agy terminal runs on, noted at every switch it outlived. */
  private readonly agyTerminalAccounts = new Map<string, string>()
  private agyPanePlans: Promise<unknown> = Promise.resolve()
  private agyPaneRestarts: Promise<unknown> = Promise.resolve()
  /** The last switch a host without a window left terminals running under Ask, for its answer. */
  private askedAgyMove: { from: string; to: string } | undefined

  /** After agy's login switched to `to`: what happens to the host's terminals still running agy. */
  onAntigravityAccountSwitched(
    change: AntigravityHostSwitch
  ): Promise<Pick<AntigravityAccountSelectResult, 'runningTerminals' | 'runningSessions'>> {
    const planned = this.agyPanePlans
      .then(() => this.planAgyPaneMove(change))
      .catch((error: unknown) => {
        // The switch is already saved: a failed plan must not fail its reply.
        console.warn('[runtime] could not plan moving running agy terminals', error)
        return {}
      })
    this.agyPanePlans = planned
    return planned
  }

  /** Answers the Ask a switch to `accountId` left open, unless a later switch replaced it. */
  answerAntigravityAsk(accountId: string): Promise<ClaudeHostRunningSessionsMove | undefined> {
    const planned = this.agyPanePlans.then(async () => {
      const asked = this.askedAgyMove
      if (!asked || asked.to !== accountId || AGY_HOST_SELECTION.current() !== accountId) {
        return undefined
      }
      this.askedAgyMove = undefined
      // A terminal started since the switch launched on the account selected now.
      const left = (await this.listAgyTerminals(accountId)).filter(
        (terminal) => terminal.account === asked.from
      )
      return this.restartAgyTerminals(left)
    })
    this.agyPanePlans = planned.catch(() => undefined)
    return planned
  }

  private async planAgyPaneMove(
    change: AntigravityHostSwitch
  ): Promise<Pick<AntigravityAccountSelectResult, 'runningTerminals' | 'runningSessions'>> {
    this.askedAgyMove = undefined
    const from = change.from ?? NO_ACCOUNT
    const off = (await this.listAgyTerminals(from)).filter(
      (terminal) => terminal.account !== change.to
    )
    if (off.length === 0) {
      return {}
    }
    const accountEmails: Record<string, string> = {}
    for (const account of [from, change.to, ...off.map((terminal) => terminal.account)]) {
      const email = account === NO_ACCOUNT ? null : AGY_HOST_SELECTION.email(account)
      if (email) {
        accountEmails[account] = email
      }
    }
    const runningTerminals: AntigravityAccountSelectionChange = {
      previousAccountId: change.from,
      accountId: change.to,
      terminals: off.map(({ pty, account }) => ({
        ptyId: pty.ptyId,
        accountId: account === NO_ACCOUNT ? null : account
      })),
      accountEmails
    }
    if (change.movesRunningSessions) {
      return { runningTerminals }
    }
    if (this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.notifier?.accountSelectedElsewhere?.('antigravity', runningTerminals)
      return {}
    }
    // The switching client's choice wins: this host's own setting is one no paired desktop edits.
    const policy =
      change.runningSessions ??
      this.store?.getSettings().antigravityAccountSwitchRunningSessions ??
      'ask'
    // As in a window, only the terminals on the account just left move; others were kept on theirs.
    const onPrevious = off.filter((terminal) => terminal.account === from)
    if (policy === 'keep' || onPrevious.length === 0) {
      return {}
    }
    if (policy === 'ask') {
      // Nobody here can answer Ask, and a restart stops a turn mid-work: only an explicit choice does that.
      const canRestart = onPrevious.filter((terminal) => this.agyTerminalRestartable(terminal))
      if (canRestart.length > 0) {
        this.askedAgyMove = { from, to: change.to }
      }
      return {
        runningSessions: {
          restarting: 0,
          notMoved: onPrevious.length,
          ...(canRestart.length > 0 ? { canRestart: canRestart.length } : {})
        }
      }
    }
    return { runningSessions: this.restartAgyTerminals(onPrevious) }
  }

  /** Restarts each terminal that can resume its conversation, one at a time; says what it did. */
  private restartAgyTerminals(terminals: readonly AgyTerminal[]): ClaudeHostRunningSessionsMove {
    const restart = terminals.filter((terminal) => this.agyTerminalRestartable(terminal))
    const previous = this.agyPaneRestarts
    // Why not awaited by the switch: each stop can take seconds, past the client's timeout.
    this.agyPaneRestarts = previous
      .then(async () => {
        for (const { pty, session } of restart) {
          await this.restartAgyTerminal(pty.ptyId, session!)
        }
      })
      .catch((error: unknown) =>
        console.warn('[runtime] could not move running agy terminals', error)
      )
    return { restarting: restart.length, notMoved: terminals.length - restart.length }
  }

  private agyTerminalRestartable(terminal: AgyTerminal): boolean {
    return terminal.session !== null && this.restartRefusalBeforeStop(terminal.pty) === null
  }

  private async restartAgyTerminal(
    ptyId: string,
    session: AgentProviderSessionMetadata
  ): Promise<void> {
    try {
      const result = await this.restartAgentPaneInPlace(
        ptyId,
        { agent: 'antigravity', providerSession: session },
        () => this.agyTerminalStillMoves(ptyId, session)
      )
      if (!result.ok) {
        console.warn('[runtime] an agy terminal did not move to the selected account', {
          ptyId,
          reason: result.reason
        })
        return
      }
      this.agyTerminalAccounts.delete(ptyId)
    } catch (error) {
      console.warn('[runtime] could not move a running agy terminal', { ptyId, error })
    }
  }

  /** Last before the stop: earlier restarts take seconds, in which the pane can leave agy, start
   *  another conversation, or a later switch can bring the host back to its account. */
  private async agyTerminalStillMoves(
    ptyId: string,
    session: AgentProviderSessionMetadata
  ): Promise<boolean> {
    const pty = this.ptysById.get(ptyId)
    const terminal = pty?.connected ? this.agyTerminalOf(pty) : null
    const selected = AGY_HOST_SELECTION.current()
    if (
      !terminal ||
      terminal.session?.id !== session.id ||
      selected === null ||
      (this.agyTerminalAccounts.get(ptyId) ?? selected) === selected
    ) {
      return false
    }
    return (await readAgentPaneForeground(this.ptyController, ptyId, 'antigravity')) === true
  }

  /** The host's own terminals with agy in front, each with the account it runs on: the one noted at
   *  an earlier switch, else `unnoted` (the account selected while it started). */
  private async listAgyTerminals(unnoted: string): Promise<AgyTerminal[]> {
    const candidates: Omit<AgyTerminal, 'account'>[] = []
    for (const [ptyId, pty] of this.ptysById) {
      const terminal = pty.connected ? this.agyTerminalOf(pty) : null
      if (terminal) {
        candidates.push(terminal)
      } else {
        this.agyTerminalAccounts.delete(ptyId)
      }
    }
    for (const ptyId of this.agyTerminalAccounts.keys()) {
      if (!this.ptysById.has(ptyId)) {
        this.agyTerminalAccounts.delete(ptyId)
      }
    }
    const running = await Promise.all(
      candidates.map((terminal) =>
        readAgentPaneForeground(this.ptyController, terminal.pty.ptyId, 'antigravity')
      )
    )
    const listed: AgyTerminal[] = []
    candidates.forEach((terminal, index) => {
      const { ptyId } = terminal.pty
      // An agy started again in that shell later launches on the account selected then.
      if (running[index] !== true) {
        this.agyTerminalAccounts.delete(ptyId)
        return
      }
      const account = this.agyTerminalAccounts.get(ptyId) ?? unnoted
      this.agyTerminalAccounts.set(ptyId, account)
      listed.push({ ...terminal, account })
    })
    return listed
  }

  private agyTerminalOf(pty: RuntimePtyWorktreeRecord): Omit<AgyTerminal, 'account'> | null {
    const recorded = this.paneOfPty(pty).paneKey
    // SSH relay, other servers' and WSL terminals keep their own agy logins.
    if (pty.connectionId !== null || isRemoteRuntimePtyId(pty.ptyId) || pty.isWsl || !recorded) {
      return null
    }
    const row = this.getAgentStatusRowsForPane(recorded).find(
      (candidate) => candidate.agentType === 'antigravity'
    )
    if (row?.structuredHost) {
      return null
    }
    const record = this.getWorkspaceSessionForWorktree(pty.worktreeId)
      ?.sleepingAgentSessionsByPaneKey?.[recorded]
    const session =
      normalizeAgentProviderSession(row?.providerSession) ??
      normalizeAgentProviderSession(
        record?.agent === 'antigravity' ? record.providerSession : undefined
      )
    if (
      !row &&
      !session &&
      pty.launchAgent !== 'antigravity' &&
      pty.foregroundAgent !== 'antigravity'
    ) {
      return null
    }
    return { pty, session: session ?? null }
  }
}
