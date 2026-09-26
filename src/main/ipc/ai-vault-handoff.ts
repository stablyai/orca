import { ipcMain } from 'electron'
import { prepareAiVaultSessionHandoff } from '../ai-vault/session-handoff-transfer'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type {
  AiVaultSessionHandoffOutcome,
  AiVaultSessionHandoffRequest
} from '../../shared/ai-vault-session-handoff'

export function registerAiVaultHandoffHandler(): void {
  ipcMain.handle('aiVault:prepareSessionHandoff', (_event, args?: AiVaultSessionHandoffRequest) =>
    handleAiVaultPrepareSessionHandoff(args)
  )
}

/**
 * Hosts whose transcripts are reachable at an arbitrary absolute path. Runtime
 * (paired-server) file access is worktree-relative, so a transcript under the
 * remote home cannot be read or written there.
 */
function toTranscriptConnectionId(
  hostId: ExecutionHostId | null | undefined
): { ok: true; connectionId: string | null } | { ok: false } {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed || parsed.kind === 'local') {
    return { ok: true, connectionId: null }
  }
  return parsed.kind === 'ssh' ? { ok: true, connectionId: parsed.targetId } : { ok: false }
}

export async function handleAiVaultPrepareSessionHandoff(
  args: AiVaultSessionHandoffRequest | undefined
): Promise<AiVaultSessionHandoffOutcome> {
  const agent = args?.agent?.trim()
  const sessionId = args?.sessionId?.trim()
  const sourceFilePath = args?.sourceFilePath?.trim()
  if (!agent || !sessionId || !sourceFilePath) {
    return { kind: 'failed', reason: 'invalid-request' }
  }

  const source = toTranscriptConnectionId(args?.sourceExecutionHostId)
  if (!source.ok) {
    return { kind: 'failed', reason: 'source-unavailable' }
  }
  const deliver = args?.deliver === 'text' ? 'text' : 'file'
  // Why: text delivery never touches the target host, so its reachability is
  // irrelevant — only a file copy needs somewhere to land.
  const target = toTranscriptConnectionId(args?.targetExecutionHostId)
  if (deliver === 'file' && !target.ok) {
    return { kind: 'failed', reason: 'target-unavailable' }
  }

  try {
    const result = await prepareAiVaultSessionHandoff({
      agent,
      sessionId,
      sourceFilePath,
      deliver,
      sourceConnectionId: source.connectionId,
      targetConnectionId: target.ok ? target.connectionId : null
    })
    return result.kind === 'unsupported' ? { kind: 'failed', reason: result.reason } : result
  } catch (error) {
    return {
      kind: 'failed',
      reason: 'transfer-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
