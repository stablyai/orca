import { OrcaRuntimeWithRestartAgentPaneInPlace } from './restart-agent-pane-in-place'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  claudeLaunchAccountId,
  isClaudePaneOnAccount,
  resolveClaudePaneFolder,
  type ClaudePaneFolder
} from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'
import { readClaudeForeground } from './claude-pane-foreground-read'
import { claudeHostAccountSwitch } from './claude-host-account-switch'
import type {
  ClaudeAccountSelectionChange,
  ClaudeHostRunningSessionsMove,
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../../shared/agent-accounts/managed-account-types'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

type ClaudePane = {
  pty: RuntimePtyWorktreeRecord
  paneKey: string
  session: AgentProviderSessionMetadata | null
}
type ClaudePaneRestart = ClaudePane & { session: AgentProviderSessionMetadata }

/** On a host with no window (serve, orcad), the host moves its own running Claude terminals when its
 *  account switches, as a desktop window does for its panes. */
export abstract class OrcaRuntimeWithClaudeRunningPaneAccountMove extends OrcaRuntimeWithRestartAgentPaneInPlace {
  private claudePanePlans: Promise<unknown> = Promise.resolve()
  private claudePaneRestarts: Promise<unknown> = Promise.resolve()
  /** Panes queued or mid-restart; their new terminal takes whatever account is selected then. */
  private readonly restartingClaudePanes = new Set<string>()
  /** Panes this host restarted, until their own status row names the conversation again. */
  private readonly restartedClaudePanes = new Map<
    string,
    /** `undefined`: switches kept landing while it restarted, so its account is unknown. */
    { session: AgentProviderSessionMetadata; accountId: string | null | undefined }
  >()
  /** Bumped by every switch, so a restart can tell its spawn may have read another selection. */
  private claudeSelectionEpoch = 0
  /** The last switch that left panes running under Ask, for its answer to restart them. */
  private askedClaudeMove: ClaudeAccountSelectionChange | undefined
  /** Counts the switches that moved the host's account: a plan from before the latest opens no Ask. */
  private claudeHostSwitches = 0

  /** A window moves its own panes; a host without one moves its own and says what it did. */
  protected onClaudeAccountSelected(
    change: ClaudeAccountSelectionChange
  ): Promise<ClaudeHostRunningSessionsMove | undefined> {
    if (this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.notifier?.claudeAccountSelected?.(change)
      return Promise.resolve(undefined)
    }
    this.claudeSelectionEpoch += 1
    const answered = this.answeredClaudeMove(change)
    const move = answered ?? change
    // A selection that moves nothing on the host (the same account again, a WSL lane) leaves the Ask open.
    if (answered || claudeHostAccountSwitch(change).movesHost) {
      this.askedClaudeMove = undefined
      this.claudeHostSwitches += 1
    }
    const hostSwitch = this.claudeHostSwitches
    // The switch is already saved: a failed plan must not fail its reply.
    const planned = this.claudePanePlans
      .then(() => this.planClaudePaneMove(move, hostSwitch))
      .catch((error: unknown) => {
        console.warn('[runtime] could not plan moving running Claude terminals', error)
        return undefined
      })
    this.claudePanePlans = planned
    // Why not awaited by the switch: each stop can take seconds, past the client's timeout.
    const previous = this.claudePaneRestarts
    this.claudePaneRestarts = planned
      .then(async (plan) => {
        await previous
        return plan && this.restartClaudePanes(plan.restart)
      })
      .catch((error: unknown) =>
        console.warn('[runtime] could not move running Claude terminals', error)
      )
    return planned.then((plan) => plan?.summary)
  }

  /** An answer restarts what its Ask left, unless a later switch moved the host off that account. */
  private answeredClaudeMove(
    change: ClaudeAccountSelectionChange
  ): ClaudeAccountSelectionChange | undefined {
    const asked = this.askedClaudeMove
    if (!asked || change.answersAskFor === undefined) {
      return undefined
    }
    const { state } = change.after
    const selected = claudeLaunchAccountId(state, change.after.accountId)
    return selected === claudeLaunchAccountId(state, change.answersAskFor) &&
      selected === claudeLaunchAccountId(asked.after.state, asked.after.accountId)
      ? { ...asked, after: change.after, runningSessions: 'restart' }
      : undefined
  }

  private async planClaudePaneMove(
    change: ClaudeAccountSelectionChange,
    hostSwitch: number
  ): Promise<
    | {
        summary: ClaudeHostRunningSessionsMove
        restart: ClaudePaneRestart[]
      }
    | undefined
  > {
    const settings = this.store?.getSettings()
    const { fromAccountId, movesHost } = claudeHostAccountSwitch(change)
    // The switching client's choice wins: this host's own setting is one no paired desktop edits.
    const policy = change.runningSessions ?? settings?.claudeAccountSwitchRunningSessions ?? 'ask'
    if (!movesHost || policy === 'keep') {
      return undefined
    }
    const saved = settings?.claudeManagedAccounts ?? []
    const host = change.after.state
    const panes = this.listClaudePanes()
    const holders = new Map<string, number>()
    for (const { session } of panes) {
      if (session) {
        holders.set(session.id, (holders.get(session.id) ?? 0) + 1)
      }
    }
    const restart: ClaudePaneRestart[] = []
    let notMoved = 0
    let canRestart = 0
    for (const pane of panes) {
      const folder = this.claudePaneFolder(pane, saved, host)
      const onOutgoing = isClaudePaneOnAccount(folder, fromAccountId, host)
      // The renderer's rule: an unread folder or session may be on the outgoing account.
      const mayBeOnOutgoing = !pane.session || !folder || onOutgoing
      if (folder?.kind === 'own-folder' || !mayBeOnOutgoing) {
        continue
      }
      const running = await readClaudeForeground(this.ptyController, pane.pty.ptyId)
      if (running === false) {
        continue
      }
      const handle = this.handleByPtyId.get(pane.pty.ptyId)
      if (
        running !== true ||
        !pane.session ||
        !folder ||
        (handle !== undefined && this.claudeAgentTeams.holdsHandle(handle)) ||
        (holders.get(pane.session.id) ?? 0) > 1 ||
        !this.terminalViewSubscribers.everyRemoteViewFollowsHostRespawn(pane.pty.ptyId)
      ) {
        notMoved += 1
        continue
      }
      // Nobody here can answer Ask, and a restart stops a turn mid-work: only an explicit choice does that.
      if (policy !== 'restart') {
        notMoved += 1
        canRestart += 1
        continue
      }
      restart.push({ ...pane, session: pane.session })
      this.restartingClaudePanes.add(pane.paneKey)
    }
    if (canRestart > 0 && hostSwitch === this.claudeHostSwitches) {
      this.askedClaudeMove = change
    }
    return restart.length + notMoved > 0
      ? {
          summary: { restarting: restart.length, notMoved, ...(canRestart ? { canRestart } : {}) },
          restart
        }
      : undefined
  }

  private claudePaneFolder(
    pane: ClaudePane,
    saved: readonly ClaudeManagedAccount[],
    host: ClaudeRateLimitAccountsState
  ): ClaudePaneFolder | undefined {
    const restarted = this.restartedClaudePanes.get(pane.pty.ptyId)
    if (restarted) {
      if (restarted.accountId === undefined) {
        return undefined
      }
      return restarted.accountId === null
        ? { kind: 'system-default' }
        : { kind: 'account', accountId: restarted.accountId }
    }
    return resolveClaudePaneFolder(pane.session?.transcriptPath, saved, host, process.platform)
  }

  /** This host's own live terminals with Claude evidence: a status row, a saved record or the launch. */
  private listClaudePanes(): ClaudePane[] {
    const panes: ClaudePane[] = []
    for (const [ptyId, pty] of this.ptysById) {
      if (!pty.connected) {
        this.restartedClaudePanes.delete(ptyId)
        continue
      }
      const pane = this.claudePaneOf(pty)
      if (pane && !this.restartingClaudePanes.has(pane.paneKey)) {
        panes.push(pane)
      }
    }
    return panes
  }

  private claudePaneOf(pty: RuntimePtyWorktreeRecord): ClaudePane | null {
    const recorded = this.paneOfPty(pty).paneKey
    // SSH relay, other servers' and WSL terminals keep their own logins.
    if (pty.connectionId !== null || isRemoteRuntimePtyId(pty.ptyId) || pty.isWsl || !recorded) {
      return null
    }
    const row = this.getAgentStatusRowsForPane(recorded).find(
      (candidate) => candidate.agentType === 'claude'
    )
    if (row?.structuredHost) {
      return null
    }
    const record = this.getWorkspaceSessionForWorktree(pty.worktreeId)
      ?.sleepingAgentSessionsByPaneKey?.[recorded]
    const savedSession = record?.agent === 'claude' ? record.providerSession : undefined
    const rowSession = normalizeAgentProviderSession(row?.providerSession)
    // A launch-seeded row repeats the resumed session's old transcript; only a hook names the new folder.
    if (rowSession && !row?.providerSessionOnly) {
      this.restartedClaudePanes.delete(pty.ptyId)
    }
    const session =
      this.restartedClaudePanes.get(pty.ptyId)?.session ??
      rowSession ??
      normalizeAgentProviderSession(savedSession)
    if (!row && !session && pty.launchAgent !== 'claude' && pty.foregroundAgent !== 'claude') {
      return null
    }
    return { pty, paneKey: `${pty.worktreeId}\0${recorded}`, session: session ?? null }
  }

  private async restartClaudePanes(panes: readonly ClaudePaneRestart[]): Promise<void> {
    for (const { pty, paneKey, session } of panes) {
      let requeued = false
      try {
        requeued = await this.restartClaudePaneOnSelectedAccount(pty, paneKey, session)
      } catch (error) {
        console.warn('[runtime] could not move a running Claude terminal', {
          ptyId: pty.ptyId,
          error
        })
      } finally {
        if (!requeued) {
          this.restartingClaudePanes.delete(paneKey)
        }
      }
    }
  }

  /** Whether, right now, the pane still runs `session` in Claude, outside Agent Teams, on an
   *  account other than the selected one: earlier restarts take seconds. A pane this pass just
   *  restarted may still be typing its own resume command, so its foreground isn't required. */
  private async claudePaneStillMoves(
    ptyId: string,
    session: AgentProviderSessionMetadata,
    justRestarted: boolean
  ): Promise<boolean> {
    const pty = this.ptysById.get(ptyId)
    const pane = pty?.connected ? this.claudePaneOf(pty) : null
    const handle = this.handleByPtyId.get(ptyId)
    if (
      !pane ||
      pane.session?.id !== session.id ||
      (handle !== undefined && this.claudeAgentTeams.holdsHandle(handle))
    ) {
      return false
    }
    const host = this.accounts.getSnapshot().claude
    const saved = this.store?.getSettings().claudeManagedAccounts ?? []
    if (
      isClaudePaneOnAccount(
        this.claudePaneFolder(pane, saved, host),
        claudeLaunchAccountId(host, host.activeAccountId),
        host
      )
    ) {
      return false
    }
    return justRestarted || (await readClaudeForeground(this.ptyController, ptyId)) === true
  }

  /** A switch landing during the restart leaves unknown which account its spawn read: restart again
   *  then, and past the limit hand the pane, still reserved, to a fresh pass. True when handed on. */
  private async restartClaudePaneOnSelectedAccount(
    pty: RuntimePtyWorktreeRecord,
    paneKey: string,
    session: AgentProviderSessionMetadata
  ): Promise<boolean> {
    let ptyId = pty.ptyId
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const epoch = this.claudeSelectionEpoch
      const restarting = ptyId
      const result = await this.restartAgentPaneInPlace(
        restarting,
        { agent: 'claude', providerSession: session },
        () => this.claudePaneStillMoves(restarting, session, attempt > 0)
      )
      if (!result.ok) {
        // After a stop (create_failed) the pane shows a failed start; a view or Start resumes it.
        console.warn('[runtime] a Claude terminal did not move to the selected account', {
          ptyId: restarting,
          reason: result.reason
        })
        return false
      }
      ptyId = result.ptyId
      if (this.claudeSelectionEpoch !== epoch) {
        // Its launch-seeded row still names the old folder; only a hook will name the real one.
        this.restartedClaudePanes.set(ptyId, { session, accountId: undefined })
        continue
      }
      const accounts = this.accounts.getSnapshot().claude
      this.restartedClaudePanes.set(ptyId, {
        session,
        accountId: claudeLaunchAccountId(accounts, accounts.activeAccountId)
      })
      return false
    }
    const replaced = this.ptysById.get(ptyId)
    if (!replaced) {
      return false
    }
    this.claudePaneRestarts = this.claudePaneRestarts.then(() =>
      this.restartClaudePanes([{ pty: replaced, paneKey, session }])
    )
    return true
  }
}
