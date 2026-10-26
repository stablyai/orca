// Prefer canonical task IDs across resumes; write provisional child rows immediately and correct them in place.

import type { AgentJournalProducerLinkage } from '../../shared/agent-session-journal-types'
import type { ClaudeSubagentIds } from './claude-subagent-id-aliases'

export type ClaudeSubagentLinkageVerdict =
  | { kind: 'linked'; linkage: AgentJournalProducerLinkage }
  /** Write with settledLinkageFor now; track a correction for the later announcement. */
  | { kind: 'pending' }

// Non-null parent references always name non-root producers; unresolved identity must not become root attribution.

export type ClaudeSubagentLinkageSource = {
  linkageFor: (parentToolUseId: string) => ClaudeSubagentLinkageVerdict
  settledLinkageFor: (
    parentToolUseId: string
  ) => Exclude<ClaudeSubagentLinkageVerdict, { kind: 'pending' }>
}

/** Resolve provider task IDs directly, as permission requests require. */
export type ClaudeAgentLinkageSource = {
  linkageForAgent: (agentId: string) => AgentJournalProducerLinkage
}

export type ClaudeSubagentLinkageEntry = { attempt: number }

export type ClaudeSubagentLinkageDeps = {
  ids: ClaudeSubagentIds
  trackedFor: (canonicalId: string) => ClaudeSubagentLinkageEntry | null
  /** Forwarded spawn calls may receive announcements; this gates correction tracking, never child attribution. */
  isForwardedParentTool?: (toolUseId: string) => boolean
  /** Map sidechain tool calls to their child owner to identify grandchildren's parents. */
  childOwnerRefOf?: (toolUseId: string) => string | null
  spawnRefOf?: (canonicalId: string) => string | null
}

/** Bound malformed or cyclic sidechains when resolving parents. */
const MAX_PARENT_RESOLUTION_DEPTH = 8

/** A known parent without agentId projects as the session's own agent. */
type ParentAgentVerdict = { kind: 'known'; agentId?: string } | { kind: 'pending' }

export class ClaudeSubagentLinkage
  implements ClaudeSubagentLinkageSource, ClaudeAgentLinkageSource
{
  constructor(private readonly deps: ClaudeSubagentLinkageDeps) {}

  linkageFor = (parentToolUseId: string): ClaudeSubagentLinkageVerdict =>
    this.resolve(parentToolUseId, false, 0)

  /** Always return writable linkage, using the raw reference when no announcement resolves it. */
  settledLinkageFor = (
    parentToolUseId: string
  ): Exclude<ClaudeSubagentLinkageVerdict, { kind: 'pending' }> => {
    const verdict = this.resolve(parentToolUseId, true, 0)
    return verdict.kind === 'pending'
      ? linked(parentToolUseId, parentToolUseId, 'agent', null, undefined)
      : verdict
  }

  /** Resolve parent and attempt through the spawn call while preserving the provider's agent ID. */
  linkageForAgent = (agentId: string): AgentJournalProducerLinkage => {
    const spawnRef = this.deps.spawnRefOf?.(agentId) ?? null
    if (spawnRef === null) {
      return { agentId, producerKind: 'agent' }
    }
    const { linkage } = this.settledLinkageFor(spawnRef)
    const { parentAgentId, ...rest } = linkage
    return {
      ...rest,
      agentId,
      ...(parentAgentId === undefined || parentAgentId === agentId ? {} : { parentAgentId })
    }
  }

  private resolve(
    parentToolUseId: string,
    settled: boolean,
    depth: number
  ): ClaudeSubagentLinkageVerdict {
    const canonical = this.deps.ids.canonical(parentToolUseId)
    // Excluded tasks remain non-root producers even when they are shells or workflows.
    const excluded = this.deps.ids.isExcluded(parentToolUseId, canonical)
    // Announcement evidence also covers self-aliases and spawn IDs recalled from earlier runs.
    const announced = this.deps.ids.isAnnounced(parentToolUseId)
    if (
      !settled &&
      !excluded &&
      !announced &&
      this.deps.isForwardedParentTool?.(parentToolUseId) === true
    ) {
      // Pending flags an identity correction; it never delays writing the child's rows.
      return { kind: 'pending' }
    }
    // A provisional parent also requires correction, even if the producer itself is settled.
    const parent = this.parentAgentFor(parentToolUseId, settled, depth)
    if (parent.kind === 'pending') {
      return { kind: 'pending' }
    }
    if (excluded) {
      return linked(parentToolUseId, canonical, 'background', null, parent.agentId)
    }
    if (announced) {
      return linked(
        parentToolUseId,
        canonical,
        'agent',
        this.deps.trackedFor(canonical),
        parent.agentId
      )
    }
    // Unannounced children retain their available reference instead of becoming root output.
    return linked(
      parentToolUseId,
      canonical,
      'agent',
      this.deps.trackedFor(canonical),
      parent.agentId
    )
  }

  /** Resolve parent IDs through the same path as their own rows so attribution agrees. */
  private parentAgentFor(
    parentToolUseId: string,
    settled: boolean,
    depth: number
  ): ParentAgentVerdict {
    const ownerRef = this.deps.childOwnerRefOf?.(parentToolUseId) ?? null
    if (ownerRef === null || depth >= MAX_PARENT_RESOLUTION_DEPTH) {
      return { kind: 'known' }
    }
    const owner = this.resolve(ownerRef, settled, depth + 1)
    if (owner.kind === 'pending') {
      return { kind: 'pending' }
    }
    return owner.kind === 'linked' && owner.linkage.agentId !== undefined
      ? { kind: 'known', agentId: owner.linkage.agentId }
      : { kind: 'known' }
  }
}

function linked(
  parentToolUseId: string,
  agentId: string,
  producerKind: NonNullable<AgentJournalProducerLinkage['producerKind']>,
  tracked: ClaudeSubagentLinkageEntry | null,
  parentAgentId: string | undefined
): Extract<ClaudeSubagentLinkageVerdict, { kind: 'linked' }> {
  return {
    kind: 'linked',
    linkage: {
      agentId,
      // Missing parents project as root; omit self-parent links from malformed cycles.
      ...(parentAgentId === undefined || parentAgentId === agentId ? {} : { parentAgentId }),
      providerParentRef: parentToolUseId,
      producerKind,
      // Omit attempt for the first run; only resumed runs need it.
      ...(tracked && tracked.attempt > 1 ? { attempt: tracked.attempt } : {})
    }
  }
}
