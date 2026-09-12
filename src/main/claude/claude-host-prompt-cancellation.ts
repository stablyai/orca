import type { ClaudePendingPrompt } from './claude-structured-prompt-types'

export class ClaudeHostPromptCancellation {
  private readonly active = new Set<ClaudePendingPrompt>()
  private readonly suppressedProviderEvents = new Set<ClaudePendingPrompt>()

  begin(prompt: ClaudePendingPrompt | null, turnId: string): ClaudePendingPrompt | null {
    if (!prompt || prompt.turnId !== turnId) {
      return null
    }
    this.active.add(prompt)
    return prompt
  }

  finish(
    prompt: ClaudePendingPrompt,
    confirmed: boolean,
    isPending: () => boolean,
    settle: () => void
  ): boolean {
    if (confirmed && isPending()) {
      settle()
      prompt.settle(null)
    }
    this.active.delete(prompt)
    const suppressed = this.suppressedProviderEvents.delete(prompt)
    return suppressed && !confirmed
  }

  consume(prompt: ClaudePendingPrompt): boolean {
    const consumed = this.active.delete(prompt)
    if (consumed) {
      this.suppressedProviderEvents.add(prompt)
    }
    return consumed
  }

  forget(prompt: ClaudePendingPrompt): void {
    this.active.delete(prompt)
  }

  clear(): void {
    this.active.clear()
    this.suppressedProviderEvents.clear()
  }
}
