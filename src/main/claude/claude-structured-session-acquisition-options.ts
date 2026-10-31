import {
  readClaudeFastModeFacts,
  readClaudeSettingsFastMode,
  readClaudeSettingsFastModePerSessionOptIn
} from './claude-structured-session-options'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'

export async function readClaudeStructuredSessionSettings(
  connection: Pick<ClaudeStreamJsonConnection, 'getSettings'>,
  timeoutMs: number | undefined
): Promise<unknown> {
  return connection.getSettings({ timeoutMs }).catch(() => null)
}

export function prepareClaudeStructuredSessionAcquisitionOptions(args: {
  settings: unknown
  initialization: unknown
}) {
  return {
    fastMode: readClaudeSettingsFastMode(args.settings),
    fastModePerSessionOptIn: readClaudeSettingsFastModePerSessionOptIn(args.settings),
    fastModeFacts: readClaudeFastModeFacts(args.initialization)
  }
}

export function claudeStructuredSessionPublicationOptions(input: {
  fastMode: boolean | null
  fastModePerSessionOptIn: boolean | null
  fastModeFacts: ReturnType<typeof readClaudeFastModeFacts>
}) {
  return {
    fastMode: input.fastMode,
    fastModePerSessionOptIn: input.fastModePerSessionOptIn,
    ...(input.fastModeFacts.state ? { fastModeState: input.fastModeFacts.state } : {}),
    ...(input.fastModeFacts.disabledReason
      ? { fastModeDisabledReason: input.fastModeFacts.disabledReason }
      : {})
  }
}
