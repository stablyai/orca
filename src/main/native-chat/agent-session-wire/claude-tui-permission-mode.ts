import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  isStructuredAgentSessionPermissionModeRestoreValue,
  readStructuredAgentSessionPermissionMode,
  type StructuredAgentSessionPermissionMode
} from '../../../shared/structured-agent-session-permission-mode'
import { readClaudeTranscriptTailLines } from '../../claude/claude-tui-exit'

export async function readClaudeTuiPermissionMode(input: {
  filePath: string
  providerSessionId: string
}): Promise<StructuredAgentSessionPermissionMode | null> {
  try {
    for await (const line of readClaudeTranscriptTailLines(input.filePath)) {
      const observed = readPermissionModeLine(line, input.providerSessionId)
      if (observed !== undefined) {
        return observed
      }
    }
    return null
  } catch {
    return null
  }
}

export function resolveClaudeNativeHandoffOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'options' | 'permissionModeRestoreValue'>,
  options: Readonly<Record<string, string>> | undefined
): {
  options: Readonly<Record<string, string>> | undefined
  permissionModeAdoption?: 'required' | 'if-confirmed'
} {
  if (record.provider !== 'claude') {
    return { options }
  }
  const requiresReport =
    isStructuredAgentSessionPermissionModeRestoreValue(record.permissionModeRestoreValue) ||
    readStructuredAgentSessionPermissionMode(record.options?.permissionMode) === 'plan'
  const permissionModeAdoption = requiresReport ? 'required' : 'if-confirmed'
  if (!options?.permissionMode) {
    return { options, permissionModeAdoption }
  }
  // The resumed provider reports the TUI's final mode; replaying this value would overwrite it.
  const { permissionMode: _permissionMode, ...rest } = options
  return { options: rest, permissionModeAdoption }
}

function readPermissionModeLine(
  line: string,
  providerSessionId: string
): StructuredAgentSessionPermissionMode | null | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (
      typeof value !== 'object' ||
      value === null ||
      !('type' in value) ||
      value.type !== 'permission-mode' ||
      !('sessionId' in value) ||
      value.sessionId !== providerSessionId
    ) {
      return undefined
    }
    return 'permissionMode' in value
      ? readStructuredAgentSessionPermissionMode(value.permissionMode)
      : null
  } catch {
    return undefined
  }
}
