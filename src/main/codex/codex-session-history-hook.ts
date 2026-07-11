import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { exportManagedCodexSessionToSystemHistory } from './codex-session-managed-export'

const EXPORTED_MANAGED_SESSION_PATHS_MAX = 1024
const exportedManagedSessionPaths = new Set<string>()

export type CodexSessionHistoryHookEvent = {
  connectionId: string | null
  hookEventName?: string
  isReplay?: boolean
  payload: ParsedAgentStatusPayload
  providerSession?: AgentProviderSessionMetadata
}

/** Schedules a single-file export when Codex proves its rollout path exists. */
export function scheduleManagedCodexSessionExportFromHook(
  event: CodexSessionHistoryHookEvent,
  systemCodexHomePath?: string
): boolean {
  const transcriptPath = event.providerSession?.transcriptPath
  const exportKey = `${systemCodexHomePath ?? ''}\0${transcriptPath ?? ''}`
  if (
    event.connectionId !== null ||
    event.isReplay === true ||
    event.payload.agentType !== 'codex' ||
    (event.hookEventName !== 'SessionStart' && event.hookEventName !== 'UserPromptSubmit') ||
    !transcriptPath ||
    exportedManagedSessionPaths.has(exportKey)
  ) {
    return false
  }

  // Why: hook delivery is the authoritative creation event, but linking must
  // not delay Codex's hook response or agent startup.
  const task = setImmediate(() => {
    const result = exportManagedCodexSessionToSystemHistory(transcriptPath, systemCodexHomePath)
    if (result === 'linked' || result === 'already-linked') {
      rememberExportedManagedSessionPath(exportKey)
    }
  })
  task.unref()
  return true
}

function rememberExportedManagedSessionPath(exportKey: string): void {
  exportedManagedSessionPaths.add(exportKey)
  while (exportedManagedSessionPaths.size > EXPORTED_MANAGED_SESSION_PATHS_MAX) {
    const oldestPath = exportedManagedSessionPaths.values().next().value
    if (!oldestPath) {
      return
    }
    exportedManagedSessionPaths.delete(oldestPath)
  }
}
