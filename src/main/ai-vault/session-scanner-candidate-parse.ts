import { readFile } from 'node:fs/promises'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { parseAgentSessionFileCached, type SessionParseStats } from './session-scanner-parse-cache'
import { withSessionExecutionHost } from './session-scanner-host-stamp'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  executionHostId: ExecutionHostId,
  parseStats: SessionParseStats,
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
): Promise<SessionParseResult> {
  try {
    let session = await parseAgentSessionFileCached(candidate, platform, parseStats)
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: null
    }
  } catch (err) {
    return {
      session: null,
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

export async function readOptionalTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}
