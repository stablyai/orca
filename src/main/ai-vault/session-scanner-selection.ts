import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { buildOpenCodeSqliteCandidatePath } from '../../shared/opencode-sqlite-session-path'

export function isSelectedSessionFile(
  selectedSessionId: string | undefined,
  agent: AiVaultAgent,
  filePath: string,
  executionHostId: string = LOCAL_EXECUTION_HOST_ID
): boolean {
  return Boolean(
    selectedSessionId?.startsWith(`${executionHostId}:${agent}:`) &&
    selectedSessionId.endsWith(`:${filePath}`)
  )
}

export function selectedSqliteSessionId(
  selectedSessionId: string | undefined,
  agent: AiVaultAgent,
  dbPath: string
): string | undefined {
  if (!selectedSessionId) {
    return undefined
  }
  const prefix = `${LOCAL_EXECUTION_HOST_ID}:${agent}:`
  const pathStart = selectedSessionId.lastIndexOf(`:${dbPath}#`)
  const sessionId = selectedSessionId.slice(prefix.length, pathStart)
  return sessionId &&
    selectedSessionId ===
      `${prefix}${sessionId}:${buildOpenCodeSqliteCandidatePath(dbPath, sessionId)}`
    ? sessionId
    : undefined
}

export function selectedWslSqliteSessionId(
  selectedSessionId: string | undefined,
  agent: AiVaultAgent,
  paths: ReadonlyMap<string, string>
): string | undefined {
  for (const [linuxPath, original] of paths) {
    const sessionId = selectedSqliteSessionId(selectedSessionId, agent, original)
    if (sessionId) {
      return `local:${agent}:${sessionId}:${buildOpenCodeSqliteCandidatePath(linuxPath, sessionId)}`
    }
  }
  return undefined
}
