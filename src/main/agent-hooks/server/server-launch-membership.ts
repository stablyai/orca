import type { AgentType } from '../../../shared/agent-status-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../../../shared/agent-session-host-authority'
import {
  launchMembershipsEqual,
  parseAgentStatusLaunchBinding,
  type AgentStatusLaunchBinding,
  type AgentStatusLaunchMembership
} from '../../../shared/agent-status-launch-membership'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerIngestStructured } from './server-ingest-structured'
import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'
import {
  isOwnerBinding,
  launchMembershipKey,
  ownerStatusBinding,
  readEnrichedStatus
} from './server-launch-membership-helpers'

export type AgentLaunchAdmission = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId: string | null
  terminalHandle?: string
  agentType: AgentType
  launchToken?: string
  prompt?: string
  binding: AgentStatusLaunchBinding
  disposition: 'created' | 'adopted'
  committedAt?: number
}

export type AgentLaunchSettlement = 'committed' | 'unconfirmed' | 'failed' | 'exited'

export abstract class AgentHookServerLaunchMembership extends AgentHookServerIngestStructured {
  private sameLaunchTerminalOwner(
    existing: EnrichedAgentHookEventPayload,
    incoming: Pick<AgentHookEventPayload, 'connectionId' | 'worktreeId' | 'terminalHandle'>
  ): boolean {
    return (
      existing.terminalHandle !== undefined &&
      incoming.terminalHandle !== undefined &&
      existing.terminalHandle === incoming.terminalHandle &&
      this.sameTerminalOwner(existing, incoming)
    )
  }

  /**
   * Admit a committed or adopted owner before provider output is available.
   * The legacy `done + sessionBoundary` payload is a compatibility projection;
   * consumers must use `launchMembership` to distinguish it from completion.
   */
  admitAgentLaunch(args: AgentLaunchAdmission): EnrichedAgentHookEventPayload | null {
    if (!parsePaneKey(args.paneKey) || !parseAgentStatusLaunchBinding(args.binding)) {
      return null
    }
    const committedAt = args.committedAt ?? Date.now()
    if (!Number.isFinite(committedAt) || committedAt <= 0) {
      return null
    }
    const membership: AgentStatusLaunchMembership = {
      binding: args.binding,
      disposition: args.disposition,
      phase: 'committed',
      committedAt
    }
    const previous = readEnrichedStatus(this.state.lastStatusByPaneKey.get(args.paneKey))
    if (previous?.launchMembership) {
      if (
        !launchMembershipsEqual(previous.launchMembership, membership) ||
        !this.sameLaunchTerminalOwner(previous, args)
      ) {
        return null
      }
      return this.replaceLaunchMembership(previous, membership, args.launchToken)
    }
    if (
      previous &&
      this.sameLaunchTerminalOwner(previous, args) &&
      ((previous.runId === undefined && previous.executionId === undefined) ||
        (previous.runId === args.binding.runId &&
          previous.executionId === args.binding.attachment.executionId))
    ) {
      // A hook can arrive while ensure is still reserved. Preserve its real
      // state and attach membership instead of overwriting it with the
      // compatibility boundary row.
      const updated: EnrichedAgentHookEventPayload = {
        ...previous,
        runId: args.binding.runId,
        executionId: args.binding.attachment.executionId,
        launchMembership: membership,
        ...(args.launchToken ? { launchToken: args.launchToken } : {})
      }
      if (
        !admitLegacyAgentStatus(
          this.state,
          'main-launch-membership',
          updated,
          AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
        )
      ) {
        return previous
      }
      this.commitStatusRowMutation(previous, updated)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitEnrichedStatus(updated)
      return updated
    }
    if (previous && !this.sameLaunchTerminalOwner(previous, args)) {
      // A provider row with no terminal join is not safe to re-key from a launch.
      // The host may still admit the owner later once the canonical surface is known.
      return null
    }
    const event: AgentHookEventPayload = {
      paneKey: args.paneKey,
      tabId: args.tabId,
      worktreeId: args.worktreeId,
      connectionId: args.connectionId,
      terminalHandle: args.terminalHandle,
      launchToken: args.launchToken,
      launchMembership: membership,
      payload: {
        state: 'done',
        sessionBoundary: true,
        prompt: args.prompt ?? '',
        agentType: args.agentType
      }
    }
    return this.applyNormalizedStatus(event, undefined, 'launch', committedAt) ?? null
  }

  /** Convenience seam for owner registries: C5's binding is the only identity source. */
  admitAgentSessionOwner(args: {
    owner: unknown
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId: string | null
    terminalHandle?: string
    agentType: AgentType
    launchToken?: string
    prompt?: string
    disposition: 'created' | 'adopted'
    committedAt?: number
  }): EnrichedAgentHookEventPayload | null {
    if (!isOwnerBinding(args.owner)) {
      return null
    }
    const binding = ownerStatusBinding(args.owner)
    if (!binding) {
      return null
    }
    return this.admitAgentLaunch({ ...args, binding })
  }

  /** Settle launch bookkeeping without making persistence success a user-action gate. */
  settleAgentLaunch(paneKey: string, settlement: AgentLaunchSettlement): boolean {
    const existing = readEnrichedStatus(this.state.lastStatusByPaneKey.get(paneKey))
    if (!existing?.launchMembership) {
      return false
    }
    if (settlement === 'failed' || settlement === 'exited') {
      const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
      if (!deleted) {
        return false
      }
      this.commitStatusRowMutation(deleted, undefined)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitStatusDropped(deleted.paneKey)
      return true
    }
    const phase = settlement === 'committed' ? 'committed' : 'unconfirmed'
    if (existing.launchMembership.phase === phase) {
      return false
    }
    this.replaceLaunchMembership(existing, { ...existing.launchMembership, phase })
    return true
  }

  /**
   * Reconcile hydrated launch rows against owner inventory. Positive owner
   * matches re-admit immediately; an incomplete inventory cannot retire absence.
   */
  reconcileAgentLaunchMembership(
    owners: readonly unknown[],
    options: { complete: boolean; connectionId?: string | null } = { complete: true }
  ): { reAdmitted: number; retired: number } {
    const admitted = new Map<string, AgentSessionOwnerBinding>()
    for (const candidate of owners) {
      const binding = ownerStatusBinding(candidate)
      if (binding && isAgentSessionOwnerBinding(candidate)) {
        admitted.set(launchMembershipKey(binding), candidate)
      }
    }
    let reAdmitted = 0
    let retired = 0
    let changed = false
    for (const [paneKey, rawEntry] of this.state.lastStatusByPaneKey) {
      const entry = readEnrichedStatus(rawEntry)
      if (!entry) {
        continue
      }
      const membership = entry.launchMembership
      if (!membership) {
        continue
      }
      const inScope =
        options.connectionId === undefined || (entry.connectionId ?? null) === options.connectionId
      if (!inScope) {
        continue
      }
      const owner = admitted.get(launchMembershipKey(membership.binding))
      if (owner !== undefined) {
        const canonicalPaneKey = makePaneKey(owner.surface.tabId, owner.surface.leafId)
        let currentPaneKey = paneKey
        let currentEntry = entry
        if (canonicalPaneKey !== paneKey) {
          if (this.state.lastStatusByPaneKey.has(canonicalPaneKey)) {
            // A complete owner inventory proves the surface, but cannot authorize
            // overwriting another row already occupying it.
            continue
          }
          this.transferPaneAuthority(paneKey, canonicalPaneKey, owner.ptyId, Date.now(), {
            authorityVerified: true
          })
          currentPaneKey = canonicalPaneKey
          const movedEntry = readEnrichedStatus(
            this.state.lastStatusByPaneKey.get(canonicalPaneKey)
          )
          if (!movedEntry) {
            continue
          }
          currentEntry = movedEntry
        }
        const surfaceChanged =
          currentEntry.terminalHandle !== owner.surface.terminalHandle ||
          currentEntry.tabId !== owner.surface.tabId ||
          currentEntry.worktreeId !== owner.surface.worktreeId
        if (
          membership.phase !== 'committed' ||
          surfaceChanged ||
          currentEntry.restoredUnconfirmed
        ) {
          const { restoredUnconfirmed: _restoredUnconfirmed, ...currentEntryWithoutRestore } =
            currentEntry
          const updated = {
            ...currentEntryWithoutRestore,
            paneKey: currentPaneKey,
            tabId: owner.surface.tabId,
            worktreeId: owner.surface.worktreeId,
            terminalHandle: owner.surface.terminalHandle,
            launchMembership: { ...membership, phase: 'committed' as const }
          }
          if (
            !admitLegacyAgentStatus(
              this.state,
              'main-launch-membership',
              updated,
              AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
            )
          ) {
            continue
          }
          this.commitStatusRowMutation(currentEntry, updated)
          this.emitEnrichedStatus(updated)
          if (membership.phase !== 'committed') {
            reAdmitted += 1
          }
          changed = true
        }
        continue
      }
      if (!options.complete) {
        continue
      }
      const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
      if (deleted) {
        this.commitStatusRowMutation(deleted, undefined, false)
        this.emitStatusDropped(paneKey)
        retired += 1
        changed = true
      }
    }
    if (changed) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    return { reAdmitted, retired }
  }

  private replaceLaunchMembership(
    existing: EnrichedAgentHookEventPayload,
    launchMembership: AgentStatusLaunchMembership,
    launchToken?: string
  ): EnrichedAgentHookEventPayload {
    const updated: EnrichedAgentHookEventPayload = {
      ...existing,
      ...(launchToken ? { launchToken } : {}),
      launchMembership
    }
    if (
      !admitLegacyAgentStatus(
        this.state,
        'main-launch-membership',
        updated,
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
      )
    ) {
      return existing
    }
    this.commitStatusRowMutation(existing, updated)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(updated)
    return updated
  }
}
