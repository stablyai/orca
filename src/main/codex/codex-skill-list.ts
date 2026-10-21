// What Codex itself reports as its skills for one folder, mapped to the `/` surface Orca publishes.
// Shared by a running chat's report and the at-rest probe, so both list exactly what Codex loaded.

import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { structuredSlashCommands } from '../../shared/structured-agent-session-composer'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexAppServerRpc } from './codex-app-server-session'
import {
  CodexAppServerUnsupportedError,
  isCodexMethodNotFoundError
} from './codex-app-server-session'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

export const CODEX_SKILLS_LIST_METHOD = 'skills/list'

/** A Codex that predates the method refuses it as unknown; it never will answer, so the client's
 *  folder scan stays the list. */
export function isCodexSkillsListUnsupported(error: unknown): boolean {
  return (
    isCodexMethodNotFoundError(error) ||
    error instanceof CodexAppServerUnsupportedError ||
    // Older builds refuse it as an unknown request variant (-32600) instead.
    (error instanceof Error &&
      error.message.includes(`unknown variant \`${CODEX_SKILLS_LIST_METHOD}\``))
  )
}

// Why a constant: the Codex adapter implements both, and a published report replaces the menu's
// own command rows on every client, old ones included.
const CODEX_CONVERSATION_COMMANDS = ['clear', 'compact'] as const

/** The command rows a Codex report carries, so a client that replaces its menu with the report
 *  keeps `/model`, `/effort`, `/clear`, `/compact` and `/goal`. */
export function codexReportCommandRows(): AgentSessionSlashCommand[] {
  return structuredSlashCommands(CODEX_CONVERSATION_COMMANDS, 'codex').map((command) => ({
    name: command.name,
    kind: 'command',
    ...(command.description ? { description: command.description } : {}),
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {})
  }))
}

function stringField(value: unknown, key: string): string | undefined {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = isRecord(value) ? value[key] : undefined
  return Array.isArray(field) ? field : []
}

/** Codex's enabled skills for `cwd`, under the names and paths Codex selects them by. */
export function codexSkillRows(answer: unknown, cwd: string): AgentSessionSlashCommand[] {
  const entries = arrayField(answer, 'data')
  const entry = entries.find((candidate) => stringField(candidate, 'cwd') === cwd) ?? entries[0]
  return arrayField(entry, 'skills').flatMap((skill): AgentSessionSlashCommand[] => {
    const name = stringField(skill, 'name')
    const path = stringField(skill, 'path')
    if (!name || !path || (isRecord(skill) && skill.enabled === false)) {
      return []
    }
    const ui = isRecord(skill) ? skill.interface : undefined
    const description =
      stringField(ui, 'shortDescription') ??
      stringField(skill, 'shortDescription') ??
      stringField(skill, 'description')
    return [{ name, kind: 'skill', path, ...(description ? { description } : {}) }]
  })
}

/** One `skills/list` for `cwd`; `forceReload` after Codex said its skills changed. */
export async function requestCodexSkillReport(
  connection: Pick<CodexAppServerConnection, 'request'> | CodexAppServerRpc,
  cwd: string,
  options: { forceReload?: boolean; timeoutMs?: number } = {}
): Promise<AgentSessionSlashCommand[]> {
  const answer = await connection.request(
    CODEX_SKILLS_LIST_METHOD,
    { cwds: [cwd], ...(options.forceReload ? { forceReload: true } : {}) },
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined
  )
  return [...codexReportCommandRows(), ...codexSkillRows(answer, cwd)]
}
