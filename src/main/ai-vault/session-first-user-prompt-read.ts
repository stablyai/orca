import { stat } from 'node:fs/promises'
import type {
  AiVaultAgent,
  AiVaultFirstUserPromptArgs,
  AiVaultFirstUserPromptResult,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type { FileWithMtime } from './session-scanner-types'

export type ReadAiVaultFirstUserPromptArgs = {
  agent: AiVaultAgent
  filePath: string
  sessionId?: string
  executionHostId?: ExecutionHostId
  codexHome?: string | null
}

export type ReadAiVaultFirstUserPromptResult = AiVaultFirstUserPromptResult

/** IPC-safe entry: validates untyped payload then reads the full first prompt. */
export async function handleAiVaultGetFirstUserPrompt(
  args?: AiVaultFirstUserPromptArgs
): Promise<AiVaultFirstUserPromptResult> {
  if (!args || typeof args.filePath !== 'string' || typeof args.agent !== 'string') {
    return { prompt: null }
  }
  return readAiVaultFirstUserPrompt({
    agent: args.agent,
    filePath: args.filePath,
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
    executionHostId: args.executionHostId,
    codexHome: args.codexHome
  })
}

/**
 * Re-parse one session transcript under full first-prompt capture and return
 * the untruncated first real user ask for copy/reuse.
 */
export async function readAiVaultFirstUserPrompt(
  args: ReadAiVaultFirstUserPromptArgs
): Promise<ReadAiVaultFirstUserPromptResult> {
  const filePath = args.filePath.trim()
  if (!filePath || !args.agent) {
    return { prompt: null }
  }

  // Why: transcript bodies live on the session host. Remote rows are skipped
  // (same posture as listSubagentSessions); UI falls back to preview text.
  const executionHostId = args.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { prompt: null }
  }

  // Why: partial/corrupt transcripts make parsers throw. Resolve null like every
  // other unavailable case instead of rejecting the IPC call.
  let session: AiVaultSession | null
  try {
    session = await withFullFirstUserPromptCapture(() =>
      parseSessionForFullFirstUserPrompt({
        agent: args.agent,
        filePath,
        sessionId: args.sessionId?.trim() || undefined,
        codexHome: args.codexHome ?? null
      })
    )
  } catch {
    return { prompt: null }
  }

  const prompt = session?.firstUserPrompt?.trim() || null
  return { prompt }
}

async function parseSessionForFullFirstUserPrompt(args: {
  agent: AiVaultAgent
  filePath: string
  sessionId?: string
  codexHome: string | null
}): Promise<AiVaultSession | null> {
  // Why: OpenCode SQLite sessions store filePath as the db path (not db#id).
  // Re-parse in-process under full capture so ALS applies and we can read the
  // earliest user row (worker list-scan path only joins newest messages).
  if (args.agent === 'opencode') {
    const fromSynthetic = splitOpenCodeSqliteCandidate(args.filePath)
    if (fromSynthetic) {
      return parseOpenCodeSqliteSession({
        dbPath: fromSynthetic.dbPath,
        sessionId: fromSynthetic.sessionId,
        platform: process.platform
      })
    }
    if (args.sessionId) {
      return parseOpenCodeSqliteSession({
        dbPath: args.filePath,
        sessionId: args.sessionId,
        platform: process.platform
      })
    }
  }

  const file = await fileWithMtimeForPath(args.filePath)
  if (!file) {
    return null
  }

  return parseAgentSessionFile(
    {
      agent: args.agent,
      file,
      codexHome: args.codexHome
    },
    process.platform
  )
}

async function fileWithMtimeForPath(filePath: string): Promise<FileWithMtime | null> {
  // OpenCode SQLite candidates use a synthetic `dbPath#sessionId` path that is
  // not a real filesystem object; parsers that need it accept the path as-is.
  if (filePath.includes('#')) {
    return {
      path: filePath,
      mtimeMs: 0,
      modifiedAt: new Date(0).toISOString()
    }
  }

  try {
    const info = await stat(filePath)
    return {
      path: filePath,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: info.size
    }
  } catch {
    return null
  }
}
