import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../shared/agent-prompt-injection'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'

export type AgentPromptInputSchedule = {
  submitWithPaste: boolean
  pasteIngestMs: number
  submitDelayMs: number
  retryDelayMs?: number
}

export function resolveAgentPromptInputSchedule(args: {
  platform: NodeJS.Platform
  agent: TerminalAgent | null
  pasteAgent: TerminalAgent | null
  pastePayload: string
  options: Pick<RuntimeAgentPromptWriteOptions, 'composerReady' | 'promptForSchedule'>
}): AgentPromptInputSchedule {
  const { platform, agent, pasteAgent, pastePayload, options } = args
  const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
  const pasteIngestMs = getTerminalPasteIngestMs(platform, pasteByteLength)
  const submitWithPaste = agentPromptSubmitJoinsPasteFrame(pasteAgent)
  const submitDelayMs = options.composerReady
    ? AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + pasteIngestMs
    : options.promptForSchedule
      ? resolveAgentPromptSubmitDelayForAgent(platform, options.promptForSchedule, agent)
      : getAgentPromptSubmitDelayMs(platform, pasteByteLength)
  const retryDelayMs =
    options.composerReady && !submitWithPaste && isTuiAgent(agent)
      ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs
      : undefined
  return {
    submitWithPaste,
    pasteIngestMs,
    submitDelayMs,
    retryDelayMs
  }
}
