// Who produced a Claude journal row, decided from the roster's own knowledge.
//
// Separate from the roster because it answers a different question. The roster
// maintains the spawn-group row a user reads; this answers, for one frame's
// `parent_tool_use_id`, WHICH child produced the rows that frame carries. Never
// whether one did: a non-null reference already settles that.
//
// It prefers the CANONICAL task id over the tool id the frame arrived under.
// Claude re-announces a resumed task under a new tool id while its task id
// stays put, so a row stamped with the tool id splits one child into two the
// moment it resumes. That is a reason to prefer the task id, not to withhold a
// row until one exists: a row written under the tool id is re-stamped in place
// once the announcement lands, and a split child still beats a child whose
// words are filed under its parent.

import type { AgentJournalProducerLinkage } from '../../shared/agent-session-journal-types'
import type { ClaudeSubagentIds } from './claude-subagent-id-aliases'

/** What a frame's `parent_tool_use_id` says about the rows it produces. */
export type ClaudeSubagentLinkageVerdict =
  /** A subagent produced them, under an identity that will not change. */
  | { kind: 'linked'; linkage: AgentJournalProducerLinkage }
  /** A subagent produced them under an identity that is not final yet. The rows
   *  are still written now — with `settledLinkageFor`'s stamp — and this is what
   *  marks them as owing a correction once the announcement lands. */
  | { kind: 'pending' }

// There is deliberately no ROOT arm. A non-null `parent_tool_use_id` names a
// child, always — so every row it produces is a child's, and the only open
// question is which identity to stamp. Reading any of them as the session's own
// would assert the parent wrote words it did not.

/** This resolver, as a write site asking who produced a row sees it. */
export type ClaudeSubagentLinkageSource = {
  linkageFor: (parentToolUseId: string) => ClaudeSubagentLinkageVerdict
  settledLinkageFor: (
    parentToolUseId: string
  ) => Exclude<ClaudeSubagentLinkageVerdict, { kind: 'pending' }>
}

/** What the roster knows about one child, reduced to what attribution needs. */
export type ClaudeSubagentLinkageEntry = { attempt: number }

export type ClaudeSubagentLinkageDeps = {
  ids: ClaudeSubagentIds
  trackedFor: (canonicalId: string) => ClaudeSubagentLinkageEntry | null
  /** Whether a tool id was forwarded at the TOP level. A child parented to one
   *  was spawned by a call the transcript shows, so an announcement naming it is
   *  still expected. Gates only whether a CORRECTION is owed, never whether the
   *  row is a child's, so a stale answer costs precision and not correctness. */
  isForwardedParentTool?: (toolUseId: string) => boolean
  /** The reference naming the child that journaled a tool call, when a child
   *  did rather than the session's own agent. A grandchild's own
   *  `parent_tool_use_id` is one of those ids, and this is the only route from
   *  it to the agent that actually spawned the grandchild. */
  childOwnerRefOf?: (toolUseId: string) => string | null
}

/** How far a sidechain is followed when naming a row's parent. Depth beyond
 *  this is past anything a transcript shows, and the guard is also what stops a
 *  malformed chain that points at itself from recursing. */
const MAX_PARENT_RESOLUTION_DEPTH = 8

/** A parent's identity, or the fact that it is not final yet. `agentId` absent
 *  with kind `known` is the truthful claim that the session's own agent is the
 *  parent, which is what an unrecorded owner also means. */
type ParentAgentVerdict = { kind: 'known'; agentId?: string } | { kind: 'pending' }

export class ClaudeSubagentLinkage implements ClaudeSubagentLinkageSource {
  constructor(private readonly deps: ClaudeSubagentLinkageDeps) {}

  linkageFor = (parentToolUseId: string): ClaudeSubagentLinkageVerdict =>
    this.resolve(parentToolUseId, false, 0)

  /** The verdict for rows that can wait no longer — the pre-announcement buffer
   *  draining on eviction, at turn settle, or at teardown. Never `pending`:
   *  under settle, a spawn call whose announcement never came resolves to its
   *  own raw id, which is the only handle that child will ever have. */
  settledLinkageFor = (
    parentToolUseId: string
  ): Exclude<ClaudeSubagentLinkageVerdict, { kind: 'pending' }> => {
    const verdict = this.resolve(parentToolUseId, true, 0)
    return verdict.kind === 'pending'
      ? linked(parentToolUseId, parentToolUseId, 'agent', null, undefined)
      : verdict
  }

  private resolve(
    parentToolUseId: string,
    settled: boolean,
    depth: number
  ): ClaudeSubagentLinkageVerdict {
    const canonical = this.deps.ids.canonical(parentToolUseId)
    // An announcement said this task is not a subagent — a backgrounded shell
    // or a workflow. Its output is still not the session's own agent's.
    const excluded = this.deps.ids.isExcluded(parentToolUseId, canonical)
    // An announcement named this spawn call, so the task id behind it is
    // settled — including the case where the two ids are the same string, which
    // comparing them could not tell from never having been announced.
    const announced = this.deps.ids.isAnnounced(parentToolUseId)
    if (
      !settled &&
      !excluded &&
      !announced &&
      this.deps.isForwardedParentTool?.(parentToolUseId) === true
    ) {
      // A top-level spawn call whose `task_started` has not landed yet. Its rows
      // are written immediately under the id it already has and re-attributed
      // when the announcement names it; `pending` is what marks them as owing
      // that correction. Nothing WAITS on this — it only decides whether a
      // correction is owed — so a reference this misses costs a row the
      // canonical id, never its author.
      return { kind: 'pending' }
    }
    // A row names its parent as well as its producer, and it persists only once
    // BOTH are final: a sidechain call's parent is another agent, whose own
    // identity can still be provisional.
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
    // Nothing is coming for this id: nested tool traffic, a grandchild inside a
    // sidechain, or a forwarded spawn call that can wait no longer. The raw
    // reference is the only handle there will ever be for it.
    return linked(
      parentToolUseId,
      canonical,
      'agent',
      this.deps.trackedFor(canonical),
      parent.agentId
    )
  }

  /** Who spawned the agent this reference names, resolved through the same path
   *  that reference's own rows resolve through — so a parent id always matches
   *  the `agentId` the parent's own rows carry, however either was settled. */
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
      // Absent means the session's own agent spawned this one, so it is only
      // ever written when ANOTHER agent is known to have. A malformed chain
      // that loops back names the agent its own ancestor; the depth guard
      // bounds that walk but cannot make its answer mean anything, and absence
      // is the truthful claim rather than a self-parent persisted for ever.
      ...(parentAgentId === undefined || parentAgentId === agentId ? {} : { parentAgentId }),
      providerParentRef: parentToolUseId,
      producerKind,
      // The first run is the absence of an attempt, like every other field
      // here: absence is the claim, so only a reopened run states one.
      ...(tracked && tracked.attempt > 1 ? { attempt: tracked.attempt } : {})
    }
  }
}
