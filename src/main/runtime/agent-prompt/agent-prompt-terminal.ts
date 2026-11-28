import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import {
  mapTerminalPrompt,
  parseTerminalPromptId,
  terminalInternalPromptId
} from '../../../shared/agent-prompt/pending-agent-prompt'
import type {
  AgentPromptRespondResult,
  PendingAgentPrompt
} from '../../../shared/rpc-contract/agent-prompt-params'
import {
  TerminalAgentPromptAnswers,
  type TerminalAgentPromptAnswerRuntime
} from '../terminal/input/terminal-agent-prompt-answer'
import type { LocatedAgentPrompt } from './located-agent-prompt'

export type AgentPromptRuntime = TerminalAgentPromptAnswerRuntime & {
  agentTransitions: {
    trackedPanes(): readonly { paneKey: string; worktreeId: string }[]
    latestRow(paneKey: string): AgentStatusIpcPayload | null
  }
}

const answerers = new WeakMap<object, TerminalAgentPromptAnswers>()

export function terminalPromptAnswersFor(runtime: AgentPromptRuntime): TerminalAgentPromptAnswers {
  const existing = answerers.get(runtime)
  if (existing) {
    return existing
  }
  const created = new TerminalAgentPromptAnswers((paneKey) =>
    runtime.agentTransitions.latestRow(paneKey)
  )
  answerers.set(runtime, created)
  return created
}

export function listTerminalPrompts(runtime: AgentPromptRuntime): LocatedAgentPrompt[] {
  const answers = terminalPromptAnswersFor(runtime)
  const located: LocatedAgentPrompt[] = []
  for (const pane of runtime.agentTransitions.trackedPanes()) {
    const row = runtime.agentTransitions.latestRow(pane.paneKey)
    const agent = row?.agentType
    if (!row || !agent || resolveNativeChatTranscriptAgent(agent) === null) {
      continue
    }
    const handle = runtime.getTerminalHandleForPaneKey(pane.paneKey)
    if (!handle) {
      continue
    }
    let ptyId: string
    try {
      ptyId = runtime.getTerminalPromptRequestBinding(handle).ptyId
    } catch {
      continue
    }
    const pending = answers.pending(runtime, { paneKey: pane.paneKey, agent, answerable: true })
    if (!pending) {
      continue
    }
    const worktreeId = row.worktreeId || pane.worktreeId
    const prompt = mapTerminalPrompt({
      ptyId,
      handle,
      worktreeId,
      agent,
      createdAt: row.stateStartedAt,
      prompt: pending
    })
    if (!prompt) {
      continue
    }
    located.push({ prompt, paneKey: pane.paneKey, agent })
  }
  return located
}

export function terminalPtyExists(runtime: AgentPromptRuntime, ptyId: string): boolean {
  for (const pane of runtime.agentTransitions.trackedPanes()) {
    const handle = runtime.getTerminalHandleForPaneKey(pane.paneKey)
    if (!handle) {
      continue
    }
    try {
      if (runtime.getTerminalPromptRequestBinding(handle).ptyId === ptyId) {
        return true
      }
    } catch {
      // A pane without a live process is not this pty.
    }
  }
  return false
}

export async function applyTerminalPrompt(
  runtime: AgentPromptRuntime,
  prompt: PendingAgentPrompt,
  optionId: string
): Promise<AgentPromptRespondResult> {
  const parsed = parseTerminalPromptId(prompt.promptId)
  if (!parsed) {
    return { ok: false, reason: 'not_found' }
  }
  const located = listTerminalPrompts(runtime).find(
    (item) => item.prompt.promptId === prompt.promptId
  )
  if (!located) {
    return { ok: false, reason: 'stale' }
  }
  const internalPromptId = terminalInternalPromptId(parsed.fingerprint)
  const answers = terminalPromptAnswersFor(runtime)
  const target = { paneKey: located.paneKey, agent: located.agent, answerable: true }
  const pending = answers.pending(runtime, target)
  if (!pending || pending.promptId !== internalPromptId) {
    return { ok: false, reason: 'stale' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  timer.unref?.()
  try {
    const outcome = await answers.answer(runtime, target, {
      promptId: internalPromptId,
      optionId,
      signal: controller.signal
    })
    if (outcome.outcome === 'accepted') {
      return { ok: true }
    }
    if (outcome.outcome === 'unknown') {
      return { ok: false, reason: 'unavailable' }
    }
    if (outcome.reason === 'prompt_not_pending') {
      return { ok: false, reason: 'stale' }
    }
    if (outcome.reason === 'option_not_offered') {
      return { ok: false, reason: 'rejected' }
    }
    return { ok: false, reason: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}
