import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { structuredSlashCommands } from '../../shared/structured-agent-session-composer'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { CodexAppServerRpc } from './codex-app-server-session'
import {
  CodexAppServerUnsupportedError,
  isCodexMethodNotFoundError
} from './codex-app-server-session'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

export const CODEX_SKILLS_LIST_METHOD = 'skills/list'

/** Older Codex versions retain the client folder scan when skills/list is unsupported. */
export function isCodexSkillsListUnsupported(error: unknown): boolean {
  return (
    isCodexMethodNotFoundError(error) ||
    error instanceof CodexAppServerUnsupportedError ||
    // Older builds refuse it as an unknown request variant (-32600) instead.
    (error instanceof Error &&
      error.message.includes(`unknown variant \`${CODEX_SKILLS_LIST_METHOD}\``))
  )
}

const CODEX_CONVERSATION_COMMANDS = ['clear', 'compact'] as const

/** Reports replace client menus, so include the built-in commands. */
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

export function codexSkillRows(answer: unknown, cwd: string): AgentSessionSlashCommand[] {
  const entries = arrayField(answer, 'data')
  return entrySkillRows(
    entries.find((candidate) => stringField(candidate, 'cwd') === cwd) ?? entries[0]
  )
}

export function codexFolderSkillReport(
  answer: unknown,
  cwd: string
): AgentSessionSlashCommand[] | undefined {
  const entry = arrayField(answer, 'data').find(
    (candidate) => stringField(candidate, 'cwd') === cwd
  )
  return entry === undefined ? undefined : [...codexReportCommandRows(), ...entrySkillRows(entry)]
}

function entrySkillRows(entry: unknown): AgentSessionSlashCommand[] {
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
