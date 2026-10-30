import { basename, extname, join } from 'node:path'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { parseMessageGraphSessionFile } from './session-scanner-graph-parsers'
import {
  isOmpSubagentTranscriptFileName,
  ompArtifactDirFor
} from './session-scanner-omp-subagent-transcripts'

// Bound simultaneous read streams to avoid stalling WSL UNC paths.
const OMP_SUBAGENT_PARSE_CONCURRENCY = 8
// Bulk reads use scan priority, leaving the exact lane for live probes.
const OMP_SUBAGENT_FS_PRIORITY = 'scan'

/** List pruned task transcripts on demand; keep parser imports out of the count module to avoid a cycle. */
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
    // Report WSL refusal so the panel can retry instead of showing no subagents.
    if (err instanceof WslTranscriptFsError) {
      recordSessionScanIssue(issues, {
        agent: 'omp',
        path: artifactDir,
        ...scanIssueTextFromError(err)
      })
    }
    return { sessions: [], issues }
  }

  const transcriptNames = entries
    .filter((entry) => isOmpSubagentTranscriptFileName(entry.name, entry.isFile()))
    .map((entry) => entry.name)
  if (transcriptNames.length === 0) {
    return { sessions: [], issues }
  }

  // Derive parent identity from the layout; the child transcript records its own distinct session ID.
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
      // The filename is the coordinator-assigned task label, preferable to the raw prompt fallback.
      title: basename(args.name, extname(args.name)),
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType: null,
        // Parent logs provide no attributable per-child terminal status.
        status: null
      }
    }
  } catch (err) {
    recordSessionScanIssue(args.issues, {
      agent: 'omp',
      path: filePath,
      ...scanIssueTextFromError(err)
    })
    return null
  }
}
