import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { AvailableCommand } from '../generated/acp-protocol.generated'

/** One reported session row as the chat's command or skill. */
export function acpSessionSlashCommand(
  command: AvailableCommand,
  dialect: Pick<AcpDialect, 'skillDescription'>,
  builtin: boolean
): AgentSessionSlashCommand {
  const skillDescription = dialect.skillDescription?.(command) ?? null
  const description = skillDescription ?? command.description
  return {
    name: command.name,
    kind: skillDescription === null ? 'command' : 'skill',
    ...(description ? { description } : {}),
    ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
    ...(builtin ? { builtin: true as const } : {})
  }
}
