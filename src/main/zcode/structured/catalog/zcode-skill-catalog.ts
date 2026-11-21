import type { AgentSessionSlashCommand } from '../../../../shared/agent-session/agent-session-wire'
import type { ZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection-types'

// zcode's `skills/referenceCatalog` lists the workspace's non-bundled skills — the `/` menu's
// provider entries. The same request answers per-session (live child) and workspace-wide (at rest).

export const ZCODE_SKILL_CATALOG_METHOD = 'skills/referenceCatalog'

export type ZcodeSkillCatalogRequest = {
  workspace: { workspacePath: string; workspaceKey: string }
  sessionId?: string
}

/** One skill row of the catalog answer; `enabled` is always true by protocol. */
type ZcodeSkillEntry = {
  name?: unknown
  description?: unknown
  path?: unknown
  scope?: unknown
}

/** Request the catalog over one connection; an unsupported method throws through. */
export async function requestZcodeSkillCatalog(
  connection: ZcodeAppServerConnection,
  request: ZcodeSkillCatalogRequest,
  timeoutMs: number | null,
  onReply?: () => void
): Promise<AgentSessionSlashCommand[] | null> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
  const result = (await connection.request(
    ZCODE_SKILL_CATALOG_METHOD,
    {
      workspace: { ...request.workspace },
      ...(request.sessionId ? { sessionId: request.sessionId } : {})
    },
    { timeoutMs, ...(onReply ? { onReply } : {}) }
  )) as { skills?: unknown } | null
  return readZcodeSkillCommands(result)
}

/** Map the catalog answer to slash-menu rows; null when the answer carries no skill list. */
export function readZcodeSkillCommands(result: unknown): AgentSessionSlashCommand[] | null {
  const skills = readSkillList(result)
  if (!skills) {
    return null
  }
  const commands: AgentSessionSlashCommand[] = []
  for (const entry of skills) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const row = entry as ZcodeSkillEntry
    const name = typeof row.name === 'string' ? row.name : ''
    if (!name) {
      continue
    }
    commands.push({
      name,
      kind: 'skill',
      ...(typeof row.description === 'string' && row.description
        ? { description: row.description }
        : {}),
      ...(typeof row.path === 'string' && row.path ? { path: row.path } : {})
    })
  }
  return commands
}

function readSkillList(result: unknown): readonly unknown[] | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
  const skills = (result as { skills?: unknown }).skills
  return Array.isArray(skills) ? skills : null
}
