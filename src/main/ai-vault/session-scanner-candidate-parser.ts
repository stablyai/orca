import type { ExecutionHostId } from '../../shared/execution-host'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import type { CursorSessionMetadataResolver } from './session-scanner-cursor-metadata'
import { parseAgentSessionFileCached, type SessionParseStats } from './session-scanner-parse-cache'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function parseSessionCandidate(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  parseStats: SessionParseStats
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
  cursorMetadataResolver?: CursorSessionMetadataResolver
}): Promise<SessionParseResult> {
  const { candidate } = args
  try {
    let session = await parseAgentSessionFileCached(candidate, args.platform, args.parseStats)
    if (session && candidate.antigravityHistoryPath && args.antigravityWorkspaceResolver) {
      session = await args.antigravityWorkspaceResolver.enrich(
        session,
        candidate.antigravityHistoryPath
      )
    }
    if (session && candidate.cursorChatsDir && args.cursorMetadataResolver) {
      session = await args.cursorMetadataResolver.enrich(
        session,
        candidate.cursorChatsDir,
        args.platform
      )
    }
    return {
      session: session ? withSessionExecutionHost(session, args.executionHostId) : null,
      issue: null
    }
  } catch (err) {
    return {
      session: null,
      issue: {
        executionHostId: args.executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

function withSessionExecutionHost(
  session: AiVaultSession,
  executionHostId: ExecutionHostId
): AiVaultSession {
  if (session.executionHostId === executionHostId) {
    return session
  }
  return {
    ...session,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
  }
}
