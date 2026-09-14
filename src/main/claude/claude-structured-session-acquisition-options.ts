import {
  readClaudeFastModeFacts,
  readClaudeSettingsFastMode,
  readClaudeSettingsFastModePerSessionOptIn
} from './claude-structured-session-options'
import { restoredClaudeStructuredSessionOptions } from './claude-structured-options'
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
  inputOptions: Readonly<Record<string, string>> | undefined
  resumed: boolean
}) {
  const fastMode = readClaudeSettingsFastMode(args.settings)
  const fastModePerSessionOptIn = readClaudeSettingsFastModePerSessionOptIn(args.settings)
  const fastModeFacts = readClaudeFastModeFacts(args.initialization)
  const options = restoredClaudeStructuredSessionOptions(args.inputOptions)
  if (!args.resumed && fastModePerSessionOptIn === true && options.get('fastMode') === 'true') {
    options.delete('fastMode')
  }
  return { fastMode, fastModePerSessionOptIn, fastModeFacts, options }
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
