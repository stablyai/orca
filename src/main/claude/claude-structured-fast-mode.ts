import type { FastModeState } from '@anthropic-ai/claude-agent-sdk'
import type { SessionOptionDescriptor } from '../../shared/native-chat-session-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { ClaudeSession } from './claude-structured-session-state'

type ClaudeFastMode = { state: FastModeState; reason: string | null }

export async function readClaudeFastMode(
  session: ClaudeSession,
  timeoutMs?: number
): Promise<ClaudeFastMode | null> {
  // initializationResult is cached; reinitialize reports the CLI's current state.
  const mutation = session.optionMutationSequence
  const result = claudeRecord(
    await session.connection.reinitialize({ timeoutMs }).catch(() => null)
  )
  const state = result?.fast_mode_state
  if (state !== 'on' && state !== 'off' && state !== 'cooldown') {
    return null
  }
  if (mutation === session.optionMutationSequence) {
    session.contextActivity?.setInitialFastMode(state)
  }
  return { state, reason: claudeText(result?.fast_mode_disabled_reason) }
}

export function claudeFastModeDescriptor(
  current: ClaudeFastMode | null,
  supportsFastMode?: boolean
): SessionOptionDescriptor | null {
  if (!current && supportsFastMode !== true) {
    return null
  }
  const enabled = current ? current.state !== 'off' : undefined
  const blocked = current?.reason && !['sdk_opt_in_required', 'preference'].includes(current.reason)
  const description =
    current?.state === 'cooldown'
      ? 'Fast mode is enabled; temporarily using standard speed during cooldown.'
      : supportsFastMode === false
        ? 'This model does not support Fast mode.'
        : blocked
          ? `Claude reports Fast mode unavailable: ${current.reason}.`
          : !current
            ? 'Claude has not reported the current Fast mode state.'
            : undefined
  return {
    id: 'fastMode',
    label: 'Fast mode',
    category: 'mode',
    kind: { type: 'boolean', ...(enabled === undefined ? {} : { currentValue: enabled }) },
    valueSource: current ? 'reported' : 'unknown',
    transport: 'agent-session',
    settable: enabled === true || (supportsFastMode !== false && !blocked),
    ...(description ? { description } : {})
  }
}

export async function applyClaudeFastMode(
  session: ClaudeSession,
  value: string,
  timeoutMs?: number
): Promise<void> {
  if (value !== 'true' && value !== 'false') {
    throw new AgentSessionOptionRejectedError('Claude fastMode must be true or false')
  }
  await session.connection.applyFlagSettings({ fastMode: value === 'true' }, { timeoutMs })
  const current = await readClaudeFastMode(session, timeoutMs)
  if (!current) {
    throw new Error('Claude did not confirm the requested Fast mode state')
  }
  if ((current.state !== 'off') !== (value === 'true')) {
    throw new AgentSessionOptionRejectedError(
      current?.reason
        ? `Claude did not enable Fast mode: ${current.reason}`
        : 'Claude did not confirm the requested Fast mode state'
    )
  }
}
