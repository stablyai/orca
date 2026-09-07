import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  AI_VAULT_TRANSCRIPT_SEARCH_HEAD_BUDGET_BYTES,
  AI_VAULT_TRANSCRIPT_SEARCH_MATCH_COUNT_CAP,
  AI_VAULT_TRANSCRIPT_SEARCH_TAIL_BUDGET_BYTES,
  extractTranscriptSearchSnippet,
  normalizeAiVaultTranscriptSearchArgs,
  type AiVaultTranscriptSearchArgs,
  type AiVaultTranscriptSearchIssue,
  type AiVaultTranscriptSearchMatch,
  type AiVaultTranscriptSearchResult
} from '../../shared/ai-vault-transcript-search'
import type { aiVaultTranscriptSearchRequestKey } from '../../shared/ai-vault-transcript-search'

// One search call must never hold the main process hostage: the per-file byte
// windows bound I/O, the deadline bounds wall time, and the abort signal lets
// a superseding query stop an in-flight sweep.
const AI_VAULT_TRANSCRIPT_SEARCH_TIME_BUDGET_MS = 5_000
// AbortSignal is only checked between lines; this keeps the check cheap.
const AI_VAULT_TRANSCRIPT_SEARCH_ABORT_CHECK_INTERVAL_LINES = 512

export type AiVaultTranscriptSearchOptions = {
  signal?: AbortSignal
  timeBudgetMs?: number
}

export async function searchAiVaultTranscripts(
  args: AiVaultTranscriptSearchArgs,
  options: AiVaultTranscriptSearchOptions = {}
): Promise<AiVaultTranscriptSearchResult> {
  const { query, requests, truncated } = normalizeAiVaultTranscriptSearchArgs(args)
  if (!query || requests.length === 0) {
    return { matches: [], issues: [], truncated }
  }
  const deadline = Date.now() + (options.timeBudgetMs ?? AI_VAULT_TRANSCRIPT_SEARCH_TIME_BUDGET_MS)
  const matches: AiVaultTranscriptSearchMatch[] = []
  const issues: AiVaultTranscriptSearchIssue[] = []
  const lowerQuery = query.toLowerCase()
  // Why: head/tail windowing skips a large transcript's middle. That is a
  // deliberate bound, but it MUST surface as `truncated` — otherwise a
  // mid-transcript hit reports an honest-looking count of zero.
  let partial = truncated

  for (const request of requests) {
    if (options.signal?.aborted) {
      return { matches, issues, truncated: true }
    }
    if (Date.now() >= deadline) {
      return { matches, issues, truncated: true }
    }
    try {
      const { match, fullyScanned } = await searchTranscriptFile(
        request,
        lowerQuery,
        deadline,
        options.signal
      )
      if (match) {
        matches.push(match)
      }
      if (!fullyScanned) {
        partial = true
      }
    } catch (error) {
      issues.push({
        agent: request.agent,
        path: request.filePath,
        message: `Transcript could not be searched: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }
  // The final file may have hit the deadline mid-window; the loop's start-of-
  // iteration checks never see that, so re-check before reporting.
  return { matches, issues, truncated: partial || Date.now() >= deadline }
}

type TranscriptFileSearchResult = {
  match: AiVaultTranscriptSearchMatch | null
  /** False when the head/tail windows skipped part of the file (the middle). */
  fullyScanned: boolean
}

async function searchTranscriptFile(
  request: Parameters<typeof aiVaultTranscriptSearchRequestKey>[0],
  lowerQuery: string,
  deadline: number,
  signal?: AbortSignal
): Promise<TranscriptFileSearchResult> {
  const fileSize = await statFileSize(request.filePath)
  // Missing transcript: a vault row can outlive its file (user cleaned the
  // agent home). Normal retention, so skip silently instead of issue-row spam.
  if (fileSize === null) {
    return { match: null, fullyScanned: true }
  }
  if (fileSize === 0) {
    return { match: null, fullyScanned: true }
  }
  if (fileSize <= AI_VAULT_TRANSCRIPT_SEARCH_TAIL_BUDGET_BYTES) {
    // Small file: one window covers it whole; nothing is a seek fragment.
    return {
      match: await searchWindow(
        request,
        lowerQuery,
        { start: 0, skipFirstLine: false },
        deadline,
        signal
      ),
      fullyScanned: true
    }
  }
  // Tail first: for "find the session where…" the recent work is the more
  // useful half, and an early deadline should keep the freshest evidence.
  const tailMatch = await searchWindow(
    request,
    lowerQuery,
    {
      start: fileSize - AI_VAULT_TRANSCRIPT_SEARCH_TAIL_BUDGET_BYTES,
      skipFirstLine: true
    },
    deadline,
    signal
  )
  if (tailMatch) {
    return { match: tailMatch, fullyScanned: fileSize <= headPlusTailBudget() }
  }
  return {
    match: await searchWindow(
      request,
      lowerQuery,
      {
        start: 0,
        skipFirstLine: false,
        byteBudget: Math.min(
          AI_VAULT_TRANSCRIPT_SEARCH_HEAD_BUDGET_BYTES,
          fileSize - AI_VAULT_TRANSCRIPT_SEARCH_TAIL_BUDGET_BYTES
        )
      },
      deadline,
      signal
    ),
    fullyScanned: fileSize <= headPlusTailBudget()
  }
}

const headPlusTailBudget = (): number =>
  AI_VAULT_TRANSCRIPT_SEARCH_HEAD_BUDGET_BYTES + AI_VAULT_TRANSCRIPT_SEARCH_TAIL_BUDGET_BYTES

/** null = the file is gone (skip silently); 0 = an empty file. */
async function statFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) {
      throw new Error('not a regular file')
    }
    return stats.size
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

type WindowSpec = { start: number; skipFirstLine: boolean; byteBudget?: number }

async function searchWindow(
  request: Parameters<typeof aiVaultTranscriptSearchRequestKey>[0],
  lowerQuery: string,
  window: WindowSpec,
  deadline: number,
  signal?: AbortSignal
): Promise<AiVaultTranscriptSearchMatch | null> {
  const stream = createReadStream(request.filePath, {
    ...(window.start > 0 ? { start: window.start } : {}),
    // Why: `bytesSeen` is only checked between complete lines. A transcript
    // that opens with one 100 MB JSONL record would otherwise be buffered in
    // full before the loop could stop; a hard `end` makes the byte budget
    // hold even for a single line larger than the window.
    ...(window.byteBudget !== undefined ? { end: window.start + window.byteBudget - 1 } : {}),
    encoding: 'utf8'
  })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    let matchCount = 0
    let snippet: string | null = null
    let firstLine = window.skipFirstLine
    let linesSeen = 0
    let bytesSeen = 0
    for await (const line of lines) {
      if (firstLine) {
        firstLine = false
        continue
      }
      linesSeen += 1
      bytesSeen += Buffer.byteLength(line) + 1
      if (
        linesSeen % AI_VAULT_TRANSCRIPT_SEARCH_ABORT_CHECK_INTERVAL_LINES === 0 &&
        (signal?.aborted || Date.now() >= deadline)
      ) {
        break
      }
      const lowerLine = line.toLowerCase()
      if (lowerLine.includes(lowerQuery)) {
        matchCount += 1
        if (!snippet) {
          snippet = extractTranscriptSearchSnippet(line, lowerQuery)
        }
        if (matchCount >= AI_VAULT_TRANSCRIPT_SEARCH_MATCH_COUNT_CAP) {
          break
        }
      }
      // Budget is enforced AFTER the line is matched: a window whose last
      // readable line is a huge partial record must still search that line.
      if (window.byteBudget !== undefined && bytesSeen > window.byteBudget) {
        break
      }
    }
    if (matchCount === 0) {
      return null
    }
    return {
      agent: request.agent,
      filePath: request.filePath,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      matchCount,
      snippet: snippet ?? ''
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}
