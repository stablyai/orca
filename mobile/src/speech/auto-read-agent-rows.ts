import { z } from 'zod'
import { isRecord } from '../../../src/shared/agent-status-child-work-value-guards'
import { AGENT_STATUS_STATES } from '../../../src/shared/agent-status-types'
import { mainAgentState } from '../../../src/shared/main-agent-status'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import type { AgentPane } from './chat-message-feeds'

/** The fields of a `worktree.ps` agent row that auto-read reads. */
export type SpokenAgentRow = Pick<
  RuntimeWorktreeAgentRow,
  | 'paneKey'
  | 'parentPaneKey'
  | 'state'
  | 'stateStartedAt'
  | 'mainAgent'
  | 'lastAssistantMessage'
  | 'toolName'
>

export type AutoReadAgentRow = SpokenAgentRow & {
  rawPaneKey: string
  worktreeId: string | null
  /** Repo or folder-workspace name, said before a message. */
  project: string | null
}

const stateSchema = z.enum(AGENT_STATUS_STATES)
const mainAgentSchema = z.object({ state: stateSchema, stateStartedAt: z.number() })

// Why: a row in a state this build does not know is skipped rather than misread.
const agentRowSchema = z.object({
  paneKey: z.string(),
  parentPaneKey: z.string().nullable().catch(null),
  state: stateSchema,
  stateStartedAt: z.number(),
  lastAssistantMessage: z.string().nullable().catch(null),
  toolName: z.string().nullable().catch(null),
  // Why: an unreadable main agent falls back to the row's state, as rows from older hosts do.
  mainAgent: mainAgentSchema.optional().catch(undefined)
})

function worktreeProjectName(worktree: Record<string, unknown>): string | null {
  const name =
    typeof worktree.repo === 'string' && worktree.repo ? worktree.repo : worktree.displayName
  return typeof name === 'string' && name ? name : null
}

// Why: pane keys are only unique within one host, so they get the host id as a prefix.
export function agentRowsFromWorktreePs(
  hostId: string,
  worktrees: readonly unknown[]
): AutoReadAgentRow[] {
  const rows: AutoReadAgentRow[] = []
  for (const worktree of worktrees) {
    if (!isRecord(worktree) || !Array.isArray(worktree.agents)) {
      continue
    }
    const { worktreeId } = worktree
    const project = worktreeProjectName(worktree)
    for (const entry of worktree.agents) {
      const parsed = agentRowSchema.safeParse(entry)
      if (!parsed.success) {
        continue
      }
      const agent = parsed.data
      rows.push({
        ...agent,
        paneKey: `${hostId}:${agent.paneKey}`,
        parentPaneKey: agent.parentPaneKey ? `${hostId}:${agent.parentPaneKey}` : null,
        rawPaneKey: agent.paneKey,
        worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
        project
      })
    }
  }
  return rows
}

export async function readAgentRows(
  hostId: string,
  client: RpcClient
): Promise<AutoReadAgentRow[]> {
  const catalog = worktreeCatalogRead.interpret(await worktreeCatalogRead.request(client, {}))
  if (!catalog.accepted) {
    throw new Error('worktree.ps refused')
  }
  return agentRowsFromWorktreePs(hostId, catalog.value.worktrees ?? [])
}

export function agentPanes(rows: readonly AutoReadAgentRow[]): AgentPane[] {
  return rows.flatMap((row) => {
    if (row.parentPaneKey || !row.worktreeId) {
      return []
    }
    const working = mainAgentState(row) === 'working'
    const turnStartedAt = working ? (row.mainAgent?.stateStartedAt ?? row.stateStartedAt) : null
    return [
      {
        paneKey: row.paneKey,
        rawPaneKey: row.rawPaneKey,
        worktreeId: row.worktreeId,
        turnStartedAt
      }
    ]
  })
}
