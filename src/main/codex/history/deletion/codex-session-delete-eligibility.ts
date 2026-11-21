import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { assertLegacyAiVaultResumeAllowed } from '../../../ai-vault/structured-sessions/structured-session-ownership'

export async function canDeleteCodexSession(sessionId: string, filePath: string): Promise<boolean> {
  try {
    assertLegacyAiVaultResumeAllowed({
      agent: 'codex',
      sessionId,
      filePath,
      codexHome: null,
      executionHostId: 'local'
    })
    for (const entry of agentHookServer.getStatusSnapshot()) {
      if (
        entry.connectionId !== null ||
        entry.agentType !== 'codex' ||
        entry.providerSession?.id.toLowerCase() !== sessionId
      ) {
        continue
      }
      if ((await agentHookServer.checkAgentPresenceSince(entry.paneKey, 0)) !== 'exited') {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
