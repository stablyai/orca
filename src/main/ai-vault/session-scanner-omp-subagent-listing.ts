import { basename, extname, join } from 'node:path'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { parseMessageGraphSessionFile } from './session-scanner-graph-parsers'
import {
  isOmpSubagentTranscriptFileName,
  ompArtifactDirFor
} from './session-scanner-omp-subagent-transcripts'
import { errorMessage } from './session-scanner-values'

// Match the Claude subagent lister's deliberate parse batching: opening every
// read stream at once stalls over WSL UNC paths.
const OMP_SUBAGENT_PARSE_CONCURRENCY = 8
// Bulk directory work, so 'scan' — same reasoning as the Claude lister.
const OMP_SUBAGENT_FS_PRIORITY = 'scan'

/**
 * List the task-subagent transcripts of one OMP session, on demand. The main
 * scan prunes session artifact directories for speed, so this is the only path
 * that reads them — and only when the user expands a session's details.
 * (Lives apart from session-scanner-omp-subagent-transcripts.ts so the graph
 * parser can import the count decorator without a parser↔lister import cycle —
 * the same split as Claude's transcripts/lister pair.)
 */
export async function listOmpSubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
}): Promise<AiVaultSubagentListResult> {
  const platform = args.platform ?? process.platform
  const issues: AiVaultScanIssue[] = []
  const artifactDir = ompArtifactDirFor(args.parentFilePath)

  let entries
  try {
    entries = await wslGatedReaddir(artifactDir, OMP_SUBAGENT_FS_PRIORITY)
  } catch (err) {
    // A gate refusal is a stalled distro, not a session without subagents —
    // report it so the panel offers a retry instead of showing an empty list.
    if (err instanceof WslTranscriptFsError) {
      recordSessionScanIssue(issues, { agent: 'omp', path: artifactDir, message: err.message })
    }
    return { sessions: [], issues }
  }

  const transcriptNames = entries
    .filter((entry) => isOmpSubagentTranscriptFileName(entry.name, entry.isFile()))
    .map((entry) => entry.name)
  if (transcriptNames.length === 0) {
    return { sessions: [], issues }
  }

  // Why: the layout fixes the parent's sessionId (<stamp>_<uuid>.jsonl → the
  // artifact dir); deriving it here keeps a child linking to its parent even
  // when the child transcript carries its own distinct session record.
  const parentSessionId = sessionIdFromFileName(args.parentFilePath)
  const parsed: (AiVaultSession | null)[] = []
  for (let index = 0; index < transcriptNames.length; index += OMP_SUBAGENT_PARSE_CONCURRENCY) {
    const batch = transcriptNames.slice(index, index + OMP_SUBAGENT_PARSE_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((name) =>
        parseOmpSubagentTranscript({ artifactDir, name, parentSessionId, platform, issues })
      )
    )
    parsed.push(...batchResults)
  }

  return {
    sessions: parsed
      .filter((session): session is AiVaultSession => session !== null)
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left)),
    issues
  }
}

async function parseOmpSubagentTranscript(args: {
  artifactDir: string
  name: string
  parentSessionId: string
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<AiVaultSession | null> {
  const filePath = join(args.artifactDir, args.name)
  try {
    const fileStat = await wslGatedStat(filePath, OMP_SUBAGENT_FS_PRIORITY)
    // The shared OMP parser decorates every parse with an artifact-dir count, so
    // a child row carries its own grandchild count. It is accurate but has no
    // renderer — subagent rows don't expand — and this lister is local-only, so
    // the remote partition never reaches it.
    const session = await parseMessageGraphSessionFile(
      'omp',
      { path: filePath, mtimeMs: fileStat.mtimeMs, modifiedAt: fileStat.mtime.toISOString() },
      args.platform
    )
    if (!session) {
      return null
    }
    return {
      ...session,
      // Why: OMP names each child transcript after the task's label — the name
      // the coordinator gave it. That beats the transcript-derived fallback
      // (the raw task prompt).
      title: basename(args.name, extname(args.name)),
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType: null,
        // OMP parents don't record per-child terminal statuses in a shape this
        // lister can attribute; unknown beats a stale guess.
        status: null
      }
    }
  } catch (err) {
    recordSessionScanIssue(args.issues, {
      agent: 'omp',
      path: filePath,
      message: errorMessage(err)
    })
    return null
  }
}
