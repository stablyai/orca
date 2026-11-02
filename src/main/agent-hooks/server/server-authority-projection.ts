import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { isTmuxInnerSubject } from '../../../shared/tmux-agent-hook-owner'
import type { AgentHookLaunchObservation, AgentHookLaunchSubject } from './server-authority-state'
import { AgentHookServerState } from './server-state'

/** Credential views never replace the semantic object that owns pending provider work. */
export abstract class AgentHookServerAuthorityProjection extends AgentHookServerState {
  getCanonicalStatusSnapshot() {
    const snapshot = this.canonicalStatusStore.getSnapshot()
    return {
      ...snapshot,
      parents: snapshot.parents.map((parent) => ({
        ...parent,
        ...(parent.status
          ? {
              status: this.projectLaunchAuthority(
                parent.status,
                this.canonicalStatusStore.getCanonicalParent(parent.subject) ?? undefined
              )
            }
          : {})
      }))
    }
  }

  protected authoritySubject(paneKey: string): AgentHookLaunchSubject | undefined {
    const legacy = this.state.lastStatusByPaneKey.get(paneKey)
    if (legacy) {
      return legacy
    }
    for (const subject of this.canonicalSubjectsByPane.get(paneKey)?.values() ?? []) {
      if (subject.kind === 'pty' && !isTmuxInnerSubject(subject)) {
        const parent = this.canonicalStatusStore.getCanonicalParent(subject)
        if (parent) {
          return parent
        }
      }
    }
    return undefined
  }

  protected applicableAuthority(observation: AgentHookLaunchObservation | undefined): boolean {
    return Boolean(
      observation &&
      observation.subject === this.authoritySubject(observation.evidence.paneKey) &&
      (observation.isCurrent?.() ?? true)
    )
  }

  protected projectLaunchAuthority<T extends { paneKey: string; launchToken?: string }>(
    row: T,
    subject?: AgentHookLaunchSubject
  ): T {
    const observation = this.currentAuthorityObservations.get(row.paneKey)
    const launchToken =
      observation?.subject === (subject ?? row) &&
      this.applicableAuthority(observation) &&
      (observation.executionIsCurrent?.() ?? true)
        ? observation.launchToken
        : undefined
    return { ...row, launchToken }
  }

  protected generationClaim(row: AgentHookEventPayload): string | undefined {
    const pending = this.pendingLaunchAuthority.get(row.paneKey)
    const observation = this.applicableAuthority(pending)
      ? pending
      : this.currentAuthorityObservations.get(row.paneKey)
    return observation?.subject === row && this.applicableAuthority(observation)
      ? observation.launchToken
      : undefined
  }
}
