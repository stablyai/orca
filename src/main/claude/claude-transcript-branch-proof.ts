import { readFile } from 'node:fs/promises'

const MAX_CLAUDE_TRANSCRIPT_ANCESTRY = 10_000

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
  relation: 'initial' | 'same' | 'descendant'
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

export function proveClaudeTranscriptBranchFromJsonl(input: {
  contents: string
  providerSessionId: string
  previousLeafUuid: string | null
}): ClaudeTranscriptBranchProof {
  const nodes = new Map<string, TranscriptNode>()
  let leafUuid: string | null = null
  let leafMarkerLineIndex = -1
  const lines = input.contents.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      if (index === lines.length - 1 && !input.contents.endsWith('\n')) {
        throw new ClaudeTranscriptTailIncompleteError()
      }
      throw transcriptError('malformed JSONL')
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw transcriptError('non-object record')
    }
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
      continue
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
  if (!leafUuid) {
    throw transcriptError('missing last-prompt marker')
  }
  const leaf = nodes.get(leafUuid)
  if (!leaf || leaf.sessionId !== input.providerSessionId || leaf.disallowedLeaf) {
    throw transcriptError('marker leaf is missing from the session graph')
  }
  if (leaf.lineIndex > leafMarkerLineIndex) {
    throw transcriptError('marker precedes its leaf record')
  }
  const previousLeafUuid = input.previousLeafUuid
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

export async function proveClaudeTranscriptBranch(input: {
  transcriptPath: string
  providerSessionId: string
  previousLeafUuid: string | null
}): Promise<ClaudeTranscriptBranchProof> {
  return proveClaudeTranscriptBranchFromJsonl({
    contents: await readFile(input.transcriptPath, 'utf8'),
    providerSessionId: input.providerSessionId,
    previousLeafUuid: input.previousLeafUuid
  })
}

/** Re-run a durable branch proof from the transcript root when a sampled cursor is stale. */
export async function readClaudeTranscriptLeafWithReproof(input: {
  readTranscriptLeaf: (input: {
    providerSessionId: string
    previousLeafUuid: string | null
    claudeConfigDir: string
  }) => Promise<string | null>
  claudeConfigDir: string
  providerSessionId: string
  previousLeafUuid: string | null
}): Promise<string | null> {
  try {
    return await input.readTranscriptLeaf({
      providerSessionId: input.providerSessionId,
      previousLeafUuid: input.previousLeafUuid,
      claudeConfigDir: input.claudeConfigDir
    })
  } catch (error) {
    // A missing cursor can be stale after compaction and is safe to re-prove from the root. A torn
    // tail is still being written; dropping the cursor would make a later sibling look admissible.
    if (
      input.previousLeafUuid === null ||
      !(error instanceof ClaudeTranscriptPreviousCursorMissingError)
    ) {
      throw error
    }
    return input.readTranscriptLeaf({
      providerSessionId: input.providerSessionId,
      previousLeafUuid: null,
      claudeConfigDir: input.claudeConfigDir
    })
  }
}
