import type { NativeChatTerminalActivity } from '../../shared/native-chat/native-chat-terminal-queue'
import type { TerminalAgent } from '../../shared/agent-status/identity/terminal-agent'
import { hermesNativeTitleStatus } from '../../shared/hermes-terminal-title'
import { evaluateAgentStateRules } from '../runtime/agent-state-rules/agent-state-rules-engine'
import type { RuledScreen } from '../runtime/terminal/wait/screen-input-veto'
import type { AgentStatus } from '../../shared/agent-status/title/agent-title-core'

export function readHermesChatActivity(input: {
  agent: TerminalAgent | null
  title: string | null
  programActivity?: AgentStatus | null
  titleObservedAt: number | null
  observedLive: boolean
  lastInputAt: number | null
  workingSequence: number
  screen: RuledScreen | null
}): NativeChatTerminalActivity {
  if (input.agent !== 'hermes') {
    throw new Error('terminal_chat_queue_requires_hermes')
  }
  const workingSequence = input.workingSequence
  if (!input.observedLive || input.titleObservedAt === null) {
    return { state: null, workingSequence }
  }
  const status = input.programActivity ?? hermesNativeTitleStatus(input.title ?? '', input.agent)
  if (status === 'working') {
    return { state: 'working', workingSequence }
  }
  if (status === 'permission') {
    return { state: 'waiting', workingSequence }
  }
  const screen = input.screen
  const ready =
    screen &&
    evaluateAgentStateRules('hermes', { readScreenLines: () => screen.lines })?.state === 'idle'
  return {
    state: status === 'idle' ? 'idle' : null,
    workingSequence,
    inputReady: status === 'idle' && !!ready && (input.lastInputAt ?? 0) <= input.titleObservedAt
  }
}
