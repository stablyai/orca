import { OrcaRuntimeWithClaudeRunningPaneAccountMove } from './claude-running-pane-account-move'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import { readAgentPaneForeground } from './agent-pane-foreground-read'
import { AGY_HOST_SELECTION } from '../../../antigravity/agy-account-selection'
import { agyTerminalIsForeign } from '../../../antigravity/agy-terminal-authority'
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
  /** Null when no hook or record named its conversation: a restart starts a new one. */
  session: AgentProviderSessionMetadata | null
  /** The saved account it runs on. */
  account: string
}

/** The account one agy invocation runs on, and the conversation that invocation reported. */
type AgyTerminalNote = { account: string; conversationId: string | null }

export type AntigravityHostSwitch = {
  from: string | null
  to: string
  /** The window that switched restarts the terminals it shows; the host only lists them. */
  movesRunningSessions?: true
  /** The switching client's choice; absent, this host's setting decides. */
  runningSessions?: ClaudeAccountSwitchRunningSessions
}

export type AntigravityUnheldTerminalsMove = {
  previousAccountId: string | null
  accountId: string
  /** Terminals the window listed but shows no pane for. */
  ptyIds: readonly string[]
  runningSessions: ClaudeAccountSwitchRunningSessions
}

/** agy keeps one login per host, so a switch leaves every agy already running in a terminal on the
 *  previous account until it restarts. A window restarts the ones it shows; the host restarts the
 *  rest, and all of them when it has no window. */
export abstract class OrcaRuntimeWithAntigravityRunningPaneAccountMove extends OrcaRuntimeWithClaudeRunningPaneAccountMove {
  /** The account each live agy terminal runs on, noted at every switch its invocation outlived. */
  private readonly agyTerminalNotes = new Map<string, AgyTerminalNote>()
  private agyPanePlans: Promise<unknown> = Promise.resolve()
  private agyPaneRestarts: Promise<unknown> = Promise.resolve()
  /** The last switch that left terminals here running under Ask, for its answer. */
  private askedAgyMove: { from: string; to: string; ptyIds?: ReadonlySet<string> } | undefined

  /** After agy's login switched to `to`: what happens to the host's terminals still running agy. */
  onAntigravityAccountSwitched(
    change: AntigravityHostSwitch
  ): Promise<Pick<AntigravityAccountSelectResult, 'runningTerminals' | 'runningSessions'>> {
    return this.planAgy(() => this.planAgyPaneMove(change), {})
  }

  /** The window's switch left these terminals, which it shows no pane for, to the host. */
  moveUnheldAntigravityTerminals(
    move: AntigravityUnheldTerminalsMove
  ): Promise<ClaudeHostRunningSessionsMove | undefined> {
    return this.planAgy(async () => {
      // A later switch replaced this one: its own listing covers these terminals.
      if (AGY_HOST_SELECTION.current() !== move.accountId) {
        return undefined
      }
      const ptyIds = new Set(move.ptyIds)
      // A terminal started since the switch launched on the account selected now.
      const off = (await this.listAgyTerminals(move.accountId)).filter(
        (terminal) => ptyIds.has(terminal.pty.ptyId) && terminal.account !== move.accountId
      )
      return this.moveAgyTerminals(off, {
        from: move.previousAccountId ?? NO_ACCOUNT,
        to: move.accountId,
        policy: move.runningSessions,
        ptyIds
      })
    }, undefined)
  }

  /** Answers the Ask a switch to `accountId` left open, unless a later switch replaced it. */
  answerAntigravityAsk(accountId: string): Promise<ClaudeHostRunningSessionsMove | undefined> {
    return this.planAgy(async () => {
      const asked = this.askedAgyMove
      if (!asked || asked.to !== accountId || AGY_HOST_SELECTION.current() !== accountId) {
        return undefined
      }
      this.askedAgyMove = undefined
      const left = (await this.listAgyTerminals(accountId)).filter(
        (terminal) =>
          terminal.account === asked.from && (!asked.ptyIds || asked.ptyIds.has(terminal.pty.ptyId))
      )
      return this.restartAgyTerminals(left)
    }, undefined)
  }

  /** The terminal's command finished or the terminal exited: a later agy there launches on the
   *  account selected then. */
  protected forgetAgyInvocation(ptyId: string): void {
    this.agyTerminalNotes.delete(ptyId)
  }

  /** One plan at a time, in switch order; a failed plan never fails the switch, already saved. */
  private planAgy<T>(plan: () => Promise<T>, fallback: T): Promise<T> {
    const planned = this.agyPanePlans.then(plan).catch((error: unknown) => {
      console.warn('[runtime] could not plan moving running agy terminals', error)
      return fallback
    })
    this.agyPanePlans = planned
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
    const accountEmails: Record<string, string> = {}
    for (const account of [from, change.to, ...off.map((terminal) => terminal.account)]) {
      const email = account === NO_ACCOUNT ? null : AGY_HOST_SELECTION.email(account)
      if (email) {
        accountEmails[account] = email
      }
    }
    // Sent even when empty: a window's open question about an earlier switch is answered by this one.
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
    const runningSessions = this.moveAgyTerminals(off, { from, to: change.to, policy })
    return runningSessions ? { runningSessions } : {}
  }

  /** As in a window, only the terminals on the account just left move; others were kept on theirs. */
  private moveAgyTerminals(
    terminals: readonly AgyTerminal[],
    move: {
      from: string
      to: string
      policy: ClaudeAccountSwitchRunningSessions
      ptyIds?: ReadonlySet<string>
    }
  ): ClaudeHostRunningSessionsMove | undefined {
    const onPrevious = terminals.filter((terminal) => terminal.account === move.from)
    if (move.policy === 'keep' || onPrevious.length === 0) {
      return undefined
    }
    if (move.policy === 'restart') {
      return this.restartAgyTerminals(onPrevious)
    }
    // Nobody here can answer Ask, and a restart stops a turn mid-work: only an explicit choice does that.
    const canRestart = onPrevious.filter((terminal) => this.agyTerminalRestartable(terminal)).length
    if (canRestart > 0) {
      this.askedAgyMove = {
        from: move.from,
        to: move.to,
        ...(move.ptyIds ? { ptyIds: move.ptyIds } : {})
      }
    }
    return {
      restarting: 0,
      notMoved: onPrevious.length,
      ...(canRestart > 0 ? { canRestart } : {})
    }
  }

  /** Restarts each terminal one at a time, resuming its conversation or starting a new one when
   *  none is known; says what it did. */
  private restartAgyTerminals(terminals: readonly AgyTerminal[]): ClaudeHostRunningSessionsMove {
    const restart = terminals.filter((terminal) => this.agyTerminalRestartable(terminal))
    const fresh = restart.filter((terminal) => terminal.session === null).length
    // Why not awaited by the switch: each stop can take seconds, past the client's timeout.
    this.agyPaneRestarts = this.agyPaneRestarts
      .then(async () => {
        for (const { pty, session } of restart) {
          await this.restartAgyTerminal(pty.ptyId, session)
        }
      })
      .catch((error: unknown) =>
        console.warn('[runtime] could not move running agy terminals', error)
      )
    return {
      restarting: restart.length,
      notMoved: terminals.length - restart.length,
      ...(fresh > 0 ? { fresh } : {})
    }
  }

  private agyTerminalRestartable(terminal: AgyTerminal): boolean {
    return this.restartRefusalBeforeStop(terminal.pty) === null
  }

  private async restartAgyTerminal(
    ptyId: string,
    session: AgentProviderSessionMetadata | null
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
      this.agyTerminalNotes.delete(ptyId)
    } catch (error) {
      console.warn('[runtime] could not move a running agy terminal', { ptyId, error })
    }
  }

  /** Last before the stop: earlier restarts take seconds, in which the pane can leave agy, start
   *  another conversation, or a later switch can bring the host back to its account. */
  private async agyTerminalStillMoves(
    ptyId: string,
    session: AgentProviderSessionMetadata | null
  ): Promise<boolean> {
    const pty = this.ptysById.get(ptyId)
    const terminal = pty?.connected ? this.agyTerminalOf(pty) : null
    const selected = AGY_HOST_SELECTION.current()
    const noted = this.agyTerminalNotes.get(ptyId)
    if (
      !terminal ||
      (terminal.session?.id ?? null) !== (session?.id ?? null) ||
      selected === null ||
      !noted ||
      noted.account === selected
    ) {
      return false
    }
    const paneKey = this.paneOfPty(terminal.pty).paneKey
    if (paneKey && (await agyTerminalIsForeign(paneKey))) {
      return false
    }
    return (await this.agyInFront(ptyId)) === true
  }

  /** The host's own terminals with agy in front, each with the account it runs on: the one noted at
   *  an earlier switch its invocation outlived, else `unnoted` (the account selected as it started).
   *  Read one at a time, since a fresh foreground read can scan the whole process table. */
  private async listAgyTerminals(unnoted: string): Promise<AgyTerminal[]> {
    for (const ptyId of this.agyTerminalNotes.keys()) {
      if (!this.ptysById.get(ptyId)?.connected) {
        this.agyTerminalNotes.delete(ptyId)
      }
    }
    const listed: AgyTerminal[] = []
    // A snapshot: the reads below await, while terminals come and go.
    const ptys = Array.from(this.ptysById.entries())
    for (const [ptyId, pty] of ptys) {
      const terminal = pty.connected ? this.agyTerminalOf(pty) : null
      const paneKey = terminal ? this.paneOfPty(pty).paneKey : null
      // A terminal whose agy reads another home's or store's login keeps it across every switch.
      const foreign = paneKey ? await agyTerminalIsForeign(paneKey) : false
      const running = terminal && !foreign ? await this.agyInFront(ptyId) : false
      if (running === false) {
        this.agyTerminalNotes.delete(ptyId)
      }
      // An unreadable foreground keeps its note for the next switch, but nothing moves blind.
      if (!terminal || running !== true) {
        continue
      }
      const conversationId = terminal.session?.id ?? null
      const noted = this.agyTerminalNotes.get(ptyId)
      // Another conversation is a later invocation, which launched on the account selected then.
      const sameInvocation =
        noted !== undefined &&
        (noted.conversationId === null ||
          conversationId === null ||
          noted.conversationId === conversationId)
      const account = sameInvocation ? noted.account : unnoted
      this.agyTerminalNotes.set(ptyId, {
        account,
        conversationId: conversationId ?? noted?.conversationId ?? null
      })
      listed.push({ ...terminal, account })
    }
    return listed
  }

  /** Whether agy is in front: a shell there (from the cached name) needs no fresh process scan. */
  private async agyInFront(ptyId: string): Promise<boolean | 'unchecked' | 'team'> {
    const name = await this.ptyController?.getForegroundProcess(ptyId).catch(() => null)
    if (name && isShellProcess(name.replace(/^-/, ''))) {
      return false
    }
    return readAgentPaneForeground(this.ptyController, ptyId, 'antigravity')
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
