// Which bytes the branch graph gets to see. Every read here pins ONE descriptor
// and ONE size before it starts, because a caller that walks the proven branch
// afterwards must walk the same snapshot the proof was computed over — a second
// read at a later size would vouch for rows nothing checked.

import { open } from 'node:fs/promises'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import {
  ClaudeTranscriptMarkerMissingError,
  ClaudeTranscriptPreviousCursorMissingError,
  ClaudeTranscriptTailIncompleteError,
  createBranchProof,
  type BranchProofInput,
  type ClaudeTranscriptBranchProof
} from './claude-transcript-branch-graph'

export {
  ClaudeTranscriptPreviousCursorMissingError,
  ClaudeTranscriptTailIncompleteError
} from './claude-transcript-branch-graph'
export type { ClaudeTranscriptBranchProof } from './claude-transcript-branch-graph'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

type AncestryRecord = Record<string, unknown>

export type ClaudeTranscriptBranchAncestry = {
  proof: ClaudeTranscriptBranchProof
  /** Leaf first, anchor excluded. */
  chain: string[]
}

type AncestryInput = BranchProofInput & {
  /** The ancestry walk stops here; the proof is what established it is reachable. */
  ancestryAnchorUuid: string
  /** The FIRST record carrying each chain uuid, in file order. */
  onAncestorRecord: (record: AncestryRecord, uuid: string) => void
}

function createAncestryReplay(
  chain: readonly string[],
  onRecord: (record: AncestryRecord, uuid: string) => void
): (line: string) => void {
  const pending = new Set(chain)
  return (line) => {
    if (!line.trim()) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Unreachable while the proof runs first over the same bytes — it throws on
      // any malformed line. Kept so a future reordering degrades, not corrupts.
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The parsed value is a non-array object checked above.
    const record = parsed as AncestryRecord
    const uuid = nonEmptyString(record.uuid)
    // `delete` is the first-occurrence tie-break, not an optimisation.
    if (uuid && pending.delete(uuid)) {
      onRecord(record, uuid)
    }
  }
}

export function proveClaudeTranscriptBranchFromJsonl(
  input: BranchProofInput & { contents: string }
): ClaudeTranscriptBranchProof {
  const proof = createBranchProof(input)
  const lines = input.contents.split('\n')
  for (const [index, line] of lines.entries()) {
    proof.add(line, index, index < lines.length - 1)
  }
  return proof.finish()
}

type PinnedTranscriptLines = () => AsyncGenerator<{ line: string; terminated: boolean }>

/**
 * Run an attempt over ONE pinned snapshot: a single fd and a single `size`, so a
 * second pass cannot read bytes the first pass did not vouch for. A repair
 * appended while we read is finished once, at the larger size, by re-running the
 * WHOLE attempt — never by reading the tail at a size the graph pass never saw.
 */
async function runPinnedTranscriptPasses<T>(
  transcriptPath: string,
  maxRecordBytes: number | undefined,
  attempt: (readLines: PinnedTranscriptLines) => Promise<T>
): Promise<T> {
  const handle = await open(transcriptPath, 'r')
  try {
    let size = (await handle.stat()).size
    let refreshed = false
    while (true) {
      const pinned = size
      const readLines: PinnedTranscriptLines = async function* () {
        if (pinned === 0) {
          return
        }
        const stream = handle.createReadStream({ start: 0, end: pinned - 1, autoClose: false })
        yield* splitTranscriptStreamLines(stream, maxRecordBytes)
      }
      try {
        return await attempt(readLines)
      } catch (error) {
        if (
          !(error instanceof ClaudeTranscriptMarkerMissingError) &&
          !(error instanceof ClaudeTranscriptPreviousCursorMissingError) &&
          !(error instanceof ClaudeTranscriptTailIncompleteError)
        ) {
          throw error
        }
        if (refreshed) {
          throw new ClaudeTranscriptTailIncompleteError()
        }
        const nextSize = await handle.stat().then(
          (current) => current.size,
          () => size
        )
        if (nextSize <= size) {
          throw error
        }
        // Finish an already-appended repair without making the caller retry.
        size = nextSize
        refreshed = true
      }
    }
  } finally {
    await handle.close()
  }
}

export async function proveClaudeTranscriptBranch(
  input: BranchProofInput & { transcriptPath: string }
): Promise<ClaudeTranscriptBranchProof> {
  return runPinnedTranscriptPasses(input.transcriptPath, undefined, async (readLines) => {
    const builder = createBranchProof(input)
    let index = 0
    for await (const record of readLines()) {
      builder.add(record.line, index++, record.terminated)
    }
    return builder.finish()
  })
}

/**
 * Prove the branch, then replay the anchor..leaf records off the SAME pinned
 * bytes. Two bounded passes instead of one whole-file string: the graph pass
 * retains uuid/parentUuid only, and the replay pass hands each chain record to
 * the caller once and keeps nothing, so neither pass holds the transcript.
 *
 * The replay runs only after `finish()` succeeds, so a growth retry can never
 * emit a record twice.
 */
export async function replayClaudeTranscriptBranchAncestry(
  input: AncestryInput & { transcriptPath: string; maxRecordBytes?: number }
): Promise<ClaudeTranscriptBranchAncestry> {
  return runPinnedTranscriptPasses(
    input.transcriptPath,
    input.maxRecordBytes,
    async (readLines) => {
      const builder = createBranchProof(input)
      let index = 0
      for await (const record of readLines()) {
        builder.add(record.line, index++, record.terminated)
      }
      const proof = builder.finish()
      const chain = builder.ancestryChain(proof.leafUuid, input.ancestryAnchorUuid)
      if (chain.length > 0) {
        const replay = createAncestryReplay(chain, input.onAncestorRecord)
        for await (const record of readLines()) {
          replay(record.line)
        }
      }
      return { proof, chain }
    }
  )
}

/** The string-source twin of `replayClaudeTranscriptBranchAncestry`. */
export function replayClaudeTranscriptBranchAncestryFromJsonl(
  input: AncestryInput & { contents: string }
): ClaudeTranscriptBranchAncestry {
  const builder = createBranchProof(input)
  const lines = input.contents.split('\n')
  for (const [index, line] of lines.entries()) {
    builder.add(line, index, index < lines.length - 1)
  }
  const proof = builder.finish()
  const chain = builder.ancestryChain(proof.leafUuid, input.ancestryAnchorUuid)
  const replay = createAncestryReplay(chain, input.onAncestorRecord)
  for (const line of lines) {
    replay(line)
  }
  return { proof, chain }
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
