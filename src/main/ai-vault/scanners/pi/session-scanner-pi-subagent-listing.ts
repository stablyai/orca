import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { wslGatedStat } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { recordSessionScanIssue, scanIssueTextFromError } from '../../parsing/session-scan-issues'
import { sessionIdFromFileName, sessionSortTime } from '../../parsing/session-scanner-accumulator'
import { parseMessageGraphSessionFile } from '../session-scanner-graph-parsers'
import { findPiSubagentTranscripts } from './session-scanner-pi-subagent-transcripts'

// Bound simultaneous read streams, matching the other subagent readers.
const PI_SUBAGENT_PARSE_CONCURRENCY = 8
const PI_SUBAGENT_FS_PRIORITY = 'scan'

/** List pi-subagents child sessions on demand; they are ordinary Pi transcripts under the parent's stem. */
export async function listPiSubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
}): Promise<AiVaultSubagentListResult> {
  const platform = args.platform ?? process.platform
  const issues: AiVaultScanIssue[] = []
  const transcriptPaths = await findPiSubagentTranscripts(args.parentFilePath)
  // Derive parent identity from the layout; the child transcript records its own session ID.
  const parentSessionId = sessionIdFromFileName(args.parentFilePath)

  const parsed: (AiVaultSession | null)[] = []
  for (let index = 0; index < transcriptPaths.length; index += PI_SUBAGENT_PARSE_CONCURRENCY) {
    const batch = transcriptPaths.slice(index, index + PI_SUBAGENT_PARSE_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((filePath) =>
        parsePiSubagentTranscript({ filePath, parentSessionId, platform, issues })
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

async function parsePiSubagentTranscript(args: {
  filePath: string
  parentSessionId: string
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<AiVaultSession | null> {
  try {
    const fileStat = await wslGatedStat(args.filePath, PI_SUBAGENT_FS_PRIORITY)
    const session = await parseMessageGraphSessionFile(
      'pi',
      { path: args.filePath, mtimeMs: fileStat.mtimeMs, modifiedAt: fileStat.mtime.toISOString() },
      args.platform
    )
    if (!session) {
      return null
    }
    return {
      ...session,
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType: null,
        // Parent logs provide no attributable per-child terminal status.
        status: null
      }
    }
  } catch (err) {
    recordSessionScanIssue(args.issues, {
      agent: 'pi',
      path: args.filePath,
      ...scanIssueTextFromError(err)
    })
    return null
  }
}
