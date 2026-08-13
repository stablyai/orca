import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import type { ClaudeSession } from './claude-structured-session-state'

const OPTION_ORDER = ['model', 'effort', 'permissionMode'] as const

export function restoredClaudeStructuredSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(
    OPTION_ORDER.flatMap((key) => {
      const value = options?.[key]
      return value ? [[key, value] as const] : []
    })
  )
}

export async function setClaudeStructuredOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  const request =
    input.key === 'model'
      ? { subtype: 'set_model', params: { model: input.value } }
      : input.key === 'permissionMode'
        ? { subtype: 'set_permission_mode', params: { mode: input.value } }
        : input.key === 'effort'
          ? { subtype: 'apply_flag_settings', params: { settings: { effortLevel: input.value } } }
          : null
  if (!request) {
    throw new AgentSessionOptionRejectedError(
      `claude stream-json has no session option named ${input.key}`
    )
  }
  try {
    await session.connection.request(request.subtype, request.params, { timeoutMs })
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  }
  session.options.set(input.key, input.value)
  return Object.fromEntries(session.options)
}

export async function restoreClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  const options = [...session.options.entries()]
  session.options.clear()
  for (const [key, value] of options) {
    await setClaudeStructuredOption(session, { key, value }, timeoutMs)
  }
}
