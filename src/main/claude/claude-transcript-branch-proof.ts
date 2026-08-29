import { readFile } from 'node:fs/promises'

const MAX_CLAUDE_TRANSCRIPT_ANCESTRY = 10_000

type TranscriptNode = {
  parentUuid: string | null
  sessionId: string | null
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

export function proveClaudeTranscriptBranchFromJsonl(input: {
  contents: string
  providerSessionId: string
  previousLeafUuid: string | null
}): ClaudeTranscriptBranchProof {
  const nodes = new Map<string, TranscriptNode>()
  let leafUuid: string | null = null
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
    if (existing && (existing.parentUuid !== parentUuid || existing.sessionId !== sessionId)) {
      throw transcriptError(`record ${uuid} has conflicting ancestry`)
    }
    nodes.set(uuid, { parentUuid, sessionId })
  }
  if (!leafUuid) {
    throw transcriptError('missing last-prompt marker')
  }
  const leaf = nodes.get(leafUuid)
  if (!leaf || leaf.sessionId !== input.providerSessionId) {
    throw transcriptError('marker leaf is missing from the session graph')
  }
  const previousLeafUuid = input.previousLeafUuid
  if (!previousLeafUuid) {
    return { leafUuid, relation: 'initial' }
  }
  const previous = nodes.get(previousLeafUuid)
  if (!previous || previous.sessionId !== input.providerSessionId) {
    throw transcriptError('previous cursor is missing from the session graph')
  }
  if (leafUuid === previousLeafUuid) {
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
    cursor = node.parentUuid
    if (cursor === previousLeafUuid) {
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
