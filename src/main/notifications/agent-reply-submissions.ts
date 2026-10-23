import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { TerminalInputOrigin } from '../../shared/terminal-input-kind'

export type AgentReplyCompletion = {
  source: 'claude' | 'codex'
  promptId: string
  transcriptPath?: string
  human: boolean
}

type PaneSubmissions = {
  sessionId: string
  source: 'claude' | 'codex'
  turns: Map<string, boolean>
  completion?: AgentReplyCompletion
  stoppedPromptId?: string
}

/** Joins live main-agent submission hooks to submit keys on the execution host. */
export class AgentReplySubmissions {
  private readonly panes = new Map<string, PaneSubmissions>()

  constructor(private readonly takeAuthor: (paneKey: string) => TerminalInputOrigin | undefined) {}

  observe(event: EnrichedAgentHookEventPayload): void {
    if (event.connectionId || event.toolAgentId || event.isReplay || event.providerSessionOnly) {
      return
    }
    const mainState = event.payload.mainAgent?.state ?? event.payload.state
    if (event.observation && event.observation.origin !== 'hook') {
      if (mainState === 'working') {
        this.clearCompletion(event.paneKey)
      }
      return
    }
    const author =
      event.hookEventName === 'UserPromptSubmit' ? this.takeAuthor(event.paneKey) : undefined
    if (event.source !== 'claude' && event.source !== 'codex') {
      this.clear(event.paneKey)
      return
    }
    if (event.hookEventName === 'SessionEnd' || event.hookEventName === 'Interrupt') {
      this.clear(event.paneKey)
      return
    }
    let pane = this.panes.get(event.paneKey)
    const sessionId =
      event.providerSession?.id ?? (pane?.source === event.source ? pane.sessionId : undefined)
    if (!sessionId) {
      this.clear(event.paneKey)
      return
    }
    // Codex's first SessionStart follows Enter; only a submission spends its author.
    if (!pane || pane.sessionId !== sessionId || pane.source !== event.source) {
      pane = { sessionId, source: event.source, turns: new Map() }
      this.panes.set(event.paneKey, pane)
    }
    const promptId = event.providerPromptId
    if (event.hookEventName === 'UserPromptSubmit') {
      pane.completion = undefined
      if (promptId) {
        if (pane.stoppedPromptId === promptId) {
          pane.turns.set(promptId, author === 'human')
          pane.stoppedPromptId = undefined
        } else {
          pane.turns.set(promptId, pane.turns.get(promptId) === true || author === 'human')
        }
      } else {
        pane.turns.clear()
        pane.stoppedPromptId = undefined
      }
    } else if (event.hookEventName === 'Stop' && promptId) {
      const human = pane.turns.get(promptId) === true
      pane.turns.clear()
      pane.turns.set(promptId, human)
      pane.stoppedPromptId = promptId
      pane.completion = {
        source: event.source,
        promptId,
        transcriptPath: event.providerSession?.transcriptPath,
        human
      }
    } else if (event.hookEventName === 'Stop' || mainState === 'working') {
      pane.completion = undefined
    }
  }

  completion(paneKey: string): AgentReplyCompletion | undefined {
    return this.panes.get(paneKey)?.completion
  }

  private clearCompletion(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (pane) {
      pane.completion = undefined
    }
  }

  clear(paneKey?: string): void {
    if (paneKey) {
      this.panes.delete(paneKey)
    } else {
      this.panes.clear()
    }
  }
}
