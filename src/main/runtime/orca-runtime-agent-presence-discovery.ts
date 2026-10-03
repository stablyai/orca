import type { AgentProcessIdentity, AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { AgentRunEvidence } from '../../shared/agent-presence-command-observer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './orca-runtime-controller-knows-pty-is-live'

export class OrcaRuntimeWithAgentPresenceDiscovery extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  private readonly agentPresenceDiscovery = new Map<string, Promise<boolean>>()
  private readonly rederivedPtys = new WeakSet<object>()

  /** Owners live only in memory: a terminal that survived a restart re-derives its owner with one
   *  read, whether a pane reattaches it or a session inventory meets it first. */
  protected rederiveSurvivingAgentOwner(ptyId: string, survived: boolean): void {
    const pty = this.ptysById.get(ptyId)
    if (!survived || !pty || this.rederivedPtys.has(pty)) {
      return
    }
    this.rederivedPtys.add(pty)
    void this.discoverAgentPresence(ptyId)
  }

  private hasAgentPresenceOwner(keys: Iterable<string>): boolean {
    return [...keys].some((key) => {
      const presence = this.getAgentOwnerFn?.(key)?.presence
      return Boolean(presence?.process && !presence.ended)
    })
  }

  /** A command-start doubts any owner: a shell running commands proves the owner is not in front. */
  protected scheduleAgentPresenceDiscovery(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty || pty.isWsl || pty.connectionId || process.platform === 'win32') {
      return
    }
    const incarnation = pty.incarnationId
    this.agentPresenceCommands.start(
      ptyId,
      () => this.ptysById.get(ptyId) === pty && pty.incarnationId === incarnation
    )
  }

  async probeWindowsAgentOwner(
    paneKey: string,
    identity: AgentProcessIdentity
  ): Promise<AgentProcessVerdict> {
    for (const [id, pty] of this.ptysById) {
      if (
        !pty.isWsl &&
        !pty.connectionId &&
        this.collectAgentStatusPaneKeysForPty(id).has(paneKey)
      ) {
        return this.ptyController?.probeAgentPresence?.(id, identity) ?? 'unverifiable'
      }
    }
    return 'unverifiable'
  }

  /** Hook evidence names its agent; each agent costs at most one read per shell command. */
  observeAgentPresenceEvidence(
    paneKey: string,
    agent: string,
    checkOwner = false,
    run?: AgentRunEvidence
  ): void {
    for (const [id] of this.ptysById) {
      if (this.collectAgentStatusPaneKeysForPty(id).has(paneKey)) {
        if (checkOwner) {
          this.recheckAgentPresenceEvidence(id, agent, run)
        } else {
          this.claimAgentPresenceEvidence(id, agent, 0, run)
        }
        return
      }
    }
  }

  protected recheckAgentPresenceEvidence(
    id: string,
    agent: string | null,
    run?: AgentRunEvidence
  ): void {
    const pty = this.ptysById.get(id)
    const incarnation = pty?.incarnationId
    const controller = this.ptyController
    void this.recheckHookAgentPresenceForPty(id).then(() => {
      if (
        agent &&
        this.ptysById.get(id) === pty &&
        pty?.incarnationId === incarnation &&
        this.ptyController === controller
      ) {
        this.claimAgentPresenceEvidence(id, agent, 0, run)
      }
    })
  }

  protected async recheckHookAgentPresenceForPty(
    ptyId: string
  ): Promise<'live' | 'unverifiable' | 'exited' | null> {
    const check = this.checkHookAgentPresenceFn
    if (!check) {
      return null
    }
    const verdicts = await Promise.all(
      Array.from(this.collectAgentStatusPaneKeysForPty(ptyId), (paneKey) => check(paneKey))
    )
    if (verdicts.includes('live')) {
      return 'live'
    }
    if (verdicts.includes('unverifiable')) {
      return 'unverifiable'
    }
    return verdicts.includes('exited') ? 'exited' : null
  }

  /** A launch is evidence for its agent, not a command, so the launch's own command-start still reads. */
  protected discoverLaunchedAgentPresence(pty: {
    ptyId: string
    launchAgent: string | null
  }): void {
    if (pty.launchAgent) {
      // Its own key: a read that ran before the agent existed must not use up the agent's evidence.
      this.claimAgentPresenceEvidence(pty.ptyId, `launch:${pty.launchAgent}`, 1_000)
    }
  }

  private claimAgentPresenceEvidence(
    ptyId: string,
    key: string,
    delayMs = 0,
    run?: AgentRunEvidence
  ): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty || pty.isWsl || pty.connectionId) {
      return
    }
    const incarnation = pty.incarnationId
    this.agentPresenceCommands.evidence(
      ptyId,
      key,
      () => this.ptysById.get(ptyId) === pty && pty.incarnationId === incarnation,
      delayMs,
      run
    )
  }

  protected discoverAgentPresence(
    ptyId: string,
    commandCurrent: () => boolean = () => true,
    doubtOwner = false,
    evidenceAtMs = Date.now()
  ): Promise<boolean> {
    const pty = this.ptysById.get(ptyId)
    const controller = this.ptyController
    if (!pty?.connected || pty.isWsl || pty.connectionId || !controller?.captureAgentPresence) {
      return Promise.resolve(false)
    }
    const incarnation = pty.incarnationId
    // Why the evidence time: a newer command must not join a read that answers an older one.
    const discoveryKey = `${ptyId}\0${incarnation}\0${evidenceAtMs}`
    const pending = this.agentPresenceDiscovery.get(discoveryKey)
    if (pending) {
      return pending
    }
    const keys = [...this.collectAgentStatusPaneKeysForPty(ptyId)]
    // Why: evidence an owner already explains costs nothing; a command-start must still look.
    const settled = () => !doubtOwner && this.hasAgentPresenceOwner(keys)
    if (settled()) {
      return Promise.resolve(true)
    }
    const current = () =>
      this.ptysById.get(ptyId) === pty &&
      pty.incarnationId === incarnation &&
      this.ptyController === controller
    const discovery = controller
      .captureAgentPresence(ptyId, {
        snapshotNotBeforeMs: evidenceAtMs,
        stillWanted: () => commandCurrent() && current()
      })
      .then((presence) => {
        if (!presence || !commandCurrent() || !current() || settled()) {
          return
        }
        for (const paneKey of keys) {
          void this.onForegroundAgentPresence?.(
            {
              paneKey,
              connectionId: null,
              worktreeId: pty.worktreeId,
              tabId: pty.tabId ?? undefined,
              terminalHandle: this.handleByPtyId.get(ptyId)
            },
            presence
          )
        }
      })
      .catch(() => undefined)
      // Why: tells evidence whether the pane is now owned, so a miss backs off and a hit re-checks.
      .then(() => this.hasAgentPresenceOwner(keys))
      .finally(() => this.agentPresenceDiscovery.delete(discoveryKey))
    this.agentPresenceDiscovery.set(discoveryKey, discovery)
    return discovery
  }
}
