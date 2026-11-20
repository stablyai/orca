import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { wslGatedStat } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { recordSessionScanIssue, scanIssueTextFromError } from '../../parsing/session-scan-issues'
import { sessionIdFromFileName, sessionSortTime } from '../../parsing/session-scanner-accumulator'
import { readTranscriptHeadValue } from '../../scope/session-scope-cwd'
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
  const walk = await findPiSubagentTranscripts(args.parentFilePath)
  if (walk.failure) {
    recordSessionScanIssue(issues, {
      agent: 'pi',
      path: walk.failure.path,
      ...scanIssueTextFromError(walk.failure.error)
    })
  }
  // A nested child sits at `<stem>/<agent>/run-N/session.jsonl`, so only its own session record names the parent.
  const parentSessionId = await parentSessionIdFor(args.parentFilePath)

  const parsed: (AiVaultSession | null)[] = []
  for (let index = 0; index < walk.paths.length; index += PI_SUBAGENT_PARSE_CONCURRENCY) {
    const batch = walk.paths.slice(index, index + PI_SUBAGENT_PARSE_CONCURRENCY)
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

/** A child's own session record names a parent that may itself be a `session.jsonl` child. */
async function parentSessionIdFor(transcriptFilePath: string): Promise<string> {
  const recorded = await readTranscriptHeadValue(transcriptFilePath, (record) =>
    record.type === 'session' ? record.id : null
  )
  return recorded ?? sessionIdFromFileName(transcriptFilePath)
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
