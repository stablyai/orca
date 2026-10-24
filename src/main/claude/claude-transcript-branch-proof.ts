// Pin one descriptor and size so ancestry proof and replay read the same append-only snapshot.

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

type AncestryInput = Omit<BranchProofInput, 'tip'> & {
  ancestryAnchorUuid: string
  /** First occurrence of each chain UUID, in file order. */
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
      // The proof pass already rejected malformed lines in this snapshot.
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The parsed value is a non-array object checked above.
    const record = parsed as AncestryRecord
    const uuid = nonEmptyString(record.uuid)
    // Deletion enforces first-occurrence identity.
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

/** Retry the whole attempt once on growth; both passes must use the newly proven snapshot. */
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
        size = nextSize
        refreshed = true
      }
    }
  } finally {
    await handle.close()
  }
}

/** Prove before replay so growth retries cannot emit records twice; retain graph identities, not bodies. */
export async function replayClaudeTranscriptBranchAncestry(
  input: AncestryInput & { transcriptPath: string; maxRecordBytes?: number }
): Promise<ClaudeTranscriptBranchAncestry> {
  return runPinnedTranscriptPasses(
    input.transcriptPath,
    input.maxRecordBytes,
    async (readLines) => {
      const builder = createBranchProof({ ...input, tip: 'file-tail' })
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

export function replayClaudeTranscriptBranchAncestryFromJsonl(
  input: AncestryInput & { contents: string }
): ClaudeTranscriptBranchAncestry {
  const builder = createBranchProof({ ...input, tip: 'file-tail' })
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
