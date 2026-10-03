import { canAdmitAgentForeground } from '../../../shared/agent-foreground-admission'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentPaneOwner,
  type AgentProcessIdentity,
  type AgentProcessPresence,
  type AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import {
  isSuspendedAgentProcess,
  probeAgentProcessPresence
} from '../../../shared/agent-process-presence-probe'
import { ownerDoubtFromHook } from '../../../shared/agent-hook-presence-transition'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'
import { AgentHookServerLifecycle } from './server-lifecycle'
import { AgentOwnerLivenessRecheck } from '../../../shared/agent-owner-liveness-recheck'

type ForegroundScope = Pick<
  AgentHookEventPayload,
  'paneKey' | 'connectionId' | 'worktreeId' | 'tabId' | 'terminalHandle'
>

export abstract class AgentHookServerAgentPresence extends AgentHookServerLifecycle {
  private windowsOwnerProbe?: (
    paneKey: string,
    identity: AgentProcessIdentity
  ) => Promise<AgentProcessVerdict>

  setWindowsAgentOwnerProbe(
    probe: (paneKey: string, identity: AgentProcessIdentity) => Promise<AgentProcessVerdict>
  ): void {
    this.windowsOwnerProbe = probe
  }

  // Why keyed by pane and owner: evidence keeps arriving, and one owner needs only one probe.
  private readonly presenceChecks = new Map<
    string,
    {
      owner: AgentProcessIdentity
      check: Promise<AgentProcessVerdict | null>
    }
  >()
  private readonly ownerLivenessRecheck = new AgentOwnerLivenessRecheck({
    listLiveOwnerPaneKeys: () =>
      [...this.agentOwnerByPaneKey.values()]
        .filter(
          (owner) => owner.connectionId === null && owner.presence.process && !owner.presence.ended
        )
        .map((owner) => owner.paneKey),
    checkOwner: (paneKey) => this.checkAgentPresence(paneKey)
  })

  protected noteLiveAgentOwner(): void {
    this.ownerLivenessRecheck.noteLiveOwner()
  }

  stop(): void {
    this.ownerLivenessRecheck.stop()
    super.stop()
  }

  /** The execution host's own foreground capture; the only local writer of an owner. */
  ingestForegroundPresence(scope: ForegroundScope, presence: AgentProcessPresence): Promise<void> {
    const paneKey = this.resolvePaneKeyAlias(scope.paneKey)
    if (this.isOwnerFenced(scope.paneKey) || isWslHookRelayConnectionId(scope.connectionId)) {
      return Promise.resolve()
    }
    const recorded = this.agentOwnerByPaneKey.get(paneKey)
    const admit = (suspended: boolean): void => {
      if (
        this.agentOwnerByPaneKey.get(paneKey) !== recorded ||
        this.isOwnerFenced(scope.paneKey) ||
        !canAdmitAgentForeground(recorded, presence, scope, suspended)
      ) {
        return
      }
      this.writeAgentOwner(paneKey, {
        ...scope,
        paneKey,
        presence: { agent: presence.agent, process: presence.process },
        receivedAt: Math.max(Date.now(), (recorded?.receivedAt ?? -1) + 1)
      })
    }
    const recordedProcess = recorded?.presence.ended ? undefined : recorded?.presence.process
    // Why: only a different process in front can doubt a live owner, and only a stop proves it yielded.
    if (
      !recordedProcess ||
      !presence.process ||
      isSameAgentProcess(recordedProcess, presence.process)
    ) {
      admit(false)
      return Promise.resolve()
    }
    return isSuspendedAgentProcess(recordedProcess)
      .catch(() => false)
      .then(admit)
  }

  /** Idle and exit hooks trigger exact-owner checks. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    if (ownerDoubtFromHook(event, this.getAgentOwner(row.paneKey)?.presence)) {
      void this.checkAgentPresence(row.paneKey)
    }
  }

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    const presence = this.getAgentOwner(paneKey)?.presence
    return Boolean(presence?.process && !presence.ended)
  }

  /** Checks the recorded process without granting ownership to the triggering event. */
  checkAgentPresence(
    paneKey: string,
    expectedProcess?: AgentProcessIdentity
  ): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const recorded = this.agentOwnerByPaneKey.get(resolved)
    const presence = recorded?.presence
    if (expectedProcess) {
      if (!presence?.process || !isSameAgentProcess(presence.process, expectedProcess)) {
        return Promise.resolve('unverifiable')
      }
      if (presence.ended) {
        return Promise.resolve('exited')
      }
    }
    const owner = presence?.process
    // Why: an ended owner already published its exit.
    if (!recorded || !presence || !owner || presence.ended) {
      return Promise.resolve(null)
    }
    if (recorded.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const pending = this.presenceChecks.get(resolved)
    if (pending && isSameAgentProcess(pending.owner, owner)) {
      return pending.check
    }
    const entry: {
      owner: AgentProcessIdentity
      check: Promise<AgentProcessVerdict | null>
    } = { owner, check: Promise.resolve(null) }
    const probe =
      owner.platform === 'win32'
        ? (this.windowsOwnerProbe?.(resolved, owner) ?? Promise.resolve('unverifiable' as const))
        : probeAgentProcessPresence(owner)
    entry.check = probe
      .catch(() => 'unverifiable' as const)
      .then((verdict) => {
        // Why: fence on the owner, not the record object — a newer capture can replace it mid-probe.
        const current: AgentPaneOwner | undefined = this.agentOwnerByPaneKey.get(resolved)
        const currentProcess = current?.presence.process
        if (!currentProcess || !isSameAgentProcess(currentProcess, owner)) {
          return 'unverifiable' as const
        }
        if (verdict !== 'exited' || current.presence.ended) {
          return verdict
        }
        this.reconcileEndedProcessForPaneKeys([resolved], {
          kind: 'owner-exited',
          presence: { ...presence, ended: true }
        })
        return verdict
      })
      .finally(() => {
        if (this.presenceChecks.get(resolved) === entry) {
          this.presenceChecks.delete(resolved)
        }
      })
    this.presenceChecks.set(resolved, entry)
    return entry.check
  }
}
