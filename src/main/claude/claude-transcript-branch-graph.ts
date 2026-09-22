// What a Claude transcript's rows MEAN as a graph, and what makes a branch
// provable from one snapshot of them. Nothing here touches the filesystem: the
// readers in `claude-transcript-branch-proof.ts` decide which bytes to feed it.

const MAX_CLAUDE_TRANSCRIPT_ANCESTRY = 10_000

class ClaudeTranscriptMarkerMissingError extends Error {
  constructor() {
    super('Claude transcript branch proof failed: missing last-prompt marker')
  }
}

type TranscriptNode = {
  parentUuid: string | null
  sessionId: string | null
  /** First line where this UUID was observed in the append-only transcript. */
  lineIndex: number
  /** UUIDs from result/init/stream frames and sidechains are never leaves. */
  disallowedLeaf: boolean
}

export type ClaudeTranscriptBranchProof = {
  leafUuid: string
  relation: 'initial' | 'same' | 'descendant' | 'intentional-rewind'
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function transcriptError(reason: string): Error {
  return new Error(`Claude transcript branch proof failed: ${reason}`)
}

export class ClaudeTranscriptTailIncompleteError extends Error {
  constructor() {
    super('Claude transcript branch proof failed: malformed JSONL')
    this.name = 'ClaudeTranscriptTailIncompleteError'
  }
}

/** The sampled cursor is no longer present, so a root proof may still recover safely. */
export class ClaudeTranscriptPreviousCursorMissingError extends Error {
  constructor() {
    super(
      'Claude transcript branch proof failed: previous cursor is missing from the session graph'
    )
    this.name = 'ClaudeTranscriptPreviousCursorMissingError'
  }
}

function proveMainLineAncestry(
  nodes: Map<string, TranscriptNode>,
  startUuid: string,
  providerSessionId: string
): void {
  const visited = new Set<string>()
  let cursor: string | null = startUuid
  for (let depth = 0; cursor !== null && depth < MAX_CLAUDE_TRANSCRIPT_ANCESTRY; depth += 1) {
    if (visited.has(cursor)) {
      throw transcriptError('cycle in parentUuid ancestry')
    }
    visited.add(cursor)
    const node = nodes.get(cursor)
    if (!node || node.sessionId !== providerSessionId) {
      throw transcriptError(`missing ancestor ${cursor}`)
    }
    if (node.disallowedLeaf) {
      throw transcriptError(`ancestor ${cursor} is not on the main transcript`)
    }
    cursor = node.parentUuid
  }
  if (cursor !== null) {
    throw transcriptError('ancestry exceeds the bounded proof limit')
  }
}

function proveAppendOrder(nodes: Map<string, TranscriptNode>): void {
  for (const node of nodes.values()) {
    if (!node.parentUuid) {
      continue
    }
    const parent = nodes.get(node.parentUuid)
    if (parent && parent.lineIndex >= node.lineIndex) {
      throw transcriptError('parent row follows descendant')
    }
  }
}

type BranchProofInput = {
  providerSessionId: string
  previousLeafUuid: string | null
  intentionalRewindUuid?: string
}

function createBranchProof(input: BranchProofInput) {
  const nodes = new Map<string, TranscriptNode>()
  let leafUuid: string | null = null
  let leafMarkerLineIndex = -1
  return { add, finish, ancestryChain }

  function add(line: string, index: number, terminated: boolean): void {
    if (!line.trim()) {
      return
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      if (!terminated) {
        throw new ClaudeTranscriptTailIncompleteError()
      }
      throw transcriptError('malformed JSONL')
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw transcriptError('non-object record')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The parsed value is a non-array object checked above.
    const row = record as Record<string, unknown>
    if (row.type === 'last-prompt') {
      const markerSessionId = nonEmptyString(row.sessionId)
      const markerLeaf = nonEmptyString(row.leafUuid)
      if (markerSessionId !== input.providerSessionId || !markerLeaf) {
        throw transcriptError('invalid last-prompt marker')
      }
      leafUuid = markerLeaf
      leafMarkerLineIndex = index
    }
    const uuid = nonEmptyString(row.uuid)
    if (!uuid) {
      return
    }
    const parentUuid = row.parentUuid === null ? null : nonEmptyString(row.parentUuid)
    if (row.parentUuid !== null && !parentUuid) {
      throw transcriptError(`record ${uuid} has no parent identity`)
    }
    const sessionId = nonEmptyString(row.sessionId)
    const existing = nodes.get(uuid)
    const disallowedLeaf =
      row.isSidechain === true ||
      row.parent_tool_use_id != null ||
      row.type === 'result' ||
      row.type === 'stream_event' ||
      (row.type === 'system' && row.subtype === 'init')
    if (
      existing &&
      (existing.parentUuid !== parentUuid ||
        existing.sessionId !== sessionId ||
        existing.disallowedLeaf !== disallowedLeaf)
    ) {
      throw transcriptError(`record ${uuid} has conflicting ancestry`)
    }
    nodes.set(uuid, {
      parentUuid,
      sessionId,
      lineIndex: existing?.lineIndex ?? index,
      disallowedLeaf
    })
  }

  function finish(): ClaudeTranscriptBranchProof {
    if (!leafUuid) {
      throw new ClaudeTranscriptMarkerMissingError()
    }
    const leaf = nodes.get(leafUuid)
    if (!leaf || leaf.sessionId !== input.providerSessionId || leaf.disallowedLeaf) {
      throw transcriptError('marker leaf is missing from the session graph')
    }
    if (leaf.lineIndex > leafMarkerLineIndex) {
      throw transcriptError('marker precedes its leaf record')
    }
    const previousLeafUuid = input.previousLeafUuid
    if (input.intentionalRewindUuid !== undefined) {
      if (leafUuid !== input.intentionalRewindUuid || !input.previousLeafUuid) {
        throw transcriptError('rewind target does not match the observed leaf')
      }
      proveMainLineAncestry(nodes, input.previousLeafUuid, input.providerSessionId)
      proveAppendOrder(nodes)
      let ancestor = nodes.get(input.previousLeafUuid)?.parentUuid ?? null
      for (let depth = 0; ancestor !== null && depth < MAX_CLAUDE_TRANSCRIPT_ANCESTRY; depth += 1) {
        if (ancestor === leafUuid) {
          return { leafUuid, relation: 'intentional-rewind' }
        }
        ancestor = nodes.get(ancestor)?.parentUuid ?? null
      }
      throw transcriptError('rewind target is not an ancestor of the previous cursor')
    }
    if (!previousLeafUuid) {
      proveMainLineAncestry(nodes, leafUuid, input.providerSessionId)
      // A branch proof is based on an append-only snapshot. A child that appears
      // before its claimed parent is not a post-snapshot descendant observation;
      // accepting that graph would turn reordered/torn rows into durable ancestry.
      proveAppendOrder(nodes)
      return { leafUuid, relation: 'initial' }
    }
    const previous = nodes.get(previousLeafUuid)
    if (!previous) {
      throw new ClaudeTranscriptPreviousCursorMissingError()
    }
    if (previous.sessionId !== input.providerSessionId || previous.disallowedLeaf) {
      throw transcriptError('previous cursor is not on the main transcript')
    }
    // The latest marker can be equal to, or descend from, a sampled cursor. In
    // either case prove the sampled cursor's own ancestry before accepting it;
    // otherwise a cursor that descended through a parent-tool-use sidechain
    // could be persisted and resumed as if it were on the main transcript.
    proveMainLineAncestry(nodes, previousLeafUuid, input.providerSessionId)
    if (leafUuid === previousLeafUuid) {
      proveAppendOrder(nodes)
      return { leafUuid, relation: 'same' }
    }
    const visited = new Set<string>()
    let cursor: string | null = leafUuid
    for (let depth = 0; cursor !== null && depth < MAX_CLAUDE_TRANSCRIPT_ANCESTRY; depth += 1) {
      if (visited.has(cursor)) {
        throw transcriptError('cycle in parentUuid ancestry')
      }
      visited.add(cursor)
      const node = nodes.get(cursor)
      if (!node || node.sessionId !== input.providerSessionId) {
        throw transcriptError(`missing ancestor ${cursor}`)
      }
      if (node.disallowedLeaf) {
        throw transcriptError(`ancestor ${cursor} is not on the main transcript`)
      }
      cursor = node.parentUuid
      if (cursor === previousLeafUuid) {
        proveAppendOrder(nodes)
        return { leafUuid, relation: 'descendant' }
      }
    }
    if (cursor !== null) {
      throw transcriptError('ancestry exceeds the bounded proof limit')
    }
    throw transcriptError('latest marker is on a sibling branch')
  }

  /** Uuids from the leaf back to (but excluding) the anchor, leaf first. Only
   *  meaningful after `finish()`, which is what proved the walk reaches the anchor.
   *
   *  A walk that does NOT reach the anchor throws rather than returning empty:
   *  empty is the caller's "nothing followed the anchor", and answering that for
   *  a broken walk would report non-delivery for records we never looked at. */
  function ancestryChain(leafUuid: string, anchorUuid: string): string[] {
    const chain: string[] = []
    let cursor: string | null = leafUuid
    for (let depth = 0; cursor !== null && cursor !== anchorUuid; depth += 1) {
      if (depth >= MAX_CLAUDE_TRANSCRIPT_ANCESTRY || !nodes.has(cursor)) {
        throw transcriptError(`ancestry chain does not reach anchor ${anchorUuid}`)
      }
      chain.push(cursor)
      cursor = nodes.get(cursor)?.parentUuid ?? null
    }
    if (cursor !== anchorUuid) {
      throw transcriptError(`ancestry chain does not reach anchor ${anchorUuid}`)
    }
    return chain
  }
}

export { ClaudeTranscriptMarkerMissingError, createBranchProof }
export type { BranchProofInput }
