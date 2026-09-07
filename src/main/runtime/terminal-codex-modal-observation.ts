import {
  detectTerminalWaitBlockedReason,
  findActionableTerminalWaitBlockedSignal
} from './terminal-wait-detection'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'

export type TerminalModalFence = {
  generation: number
  outputSequence: number
  permissionSequence: number
}

type Retirement = TerminalModalFence & { prefix: string }

// Only the model/effort picker can be retired without an agent lifecycle event.
export function hasCodexModelPickerTail(text: string): boolean {
  const normalized = text.toLowerCase()
  const signal = findActionableTerminalWaitBlockedSignal(normalized)
  const prompt = normalized.lastIndexOf('press enter to confirm')
  if (prompt === -1 || signal?.reason !== 'codex-interactive-prompt' || signal.index !== prompt) {
    return false
  }
  const context = text.slice(Math.max(0, prompt - 600), prompt)
  return (
    /(?:select|choose) (?:a )?(?:model|reasoning effort)/i.test(context) &&
    !/permission|approval|allow once|allow always|reject|deny|trust|sandbox|hook/i.test(context)
  )
}

export class TerminalCodexModalObservation {
  private readonly retired = new WeakMap<object, Retirement>()

  read(record: object, text: string, fence: TerminalModalFence): string {
    const retired = this.retired.get(record)
    if (
      retired?.generation !== fence.generation ||
      retired.permissionSequence !== fence.permissionSequence ||
      !text.startsWith(retired.prefix)
    ) {
      return text
    }
    return text.slice(retired.prefix.length)
  }

  isReady(record: object, text: string, fence: TerminalModalFence): boolean {
    const retired = this.retired.get(record)
    return (
      retired?.outputSequence === fence.outputSequence && this.read(record, text, fence) !== text
    )
  }

  reconcile(
    record: object,
    text: string,
    before: TerminalModalFence,
    after: TerminalModalFence,
    screen: RuntimeVisibleTerminalState | null
  ): void {
    if (
      !hasCodexModelPickerTail(text) ||
      before.generation !== after.generation ||
      before.outputSequence !== after.outputSequence ||
      before.permissionSequence !== after.permissionSequence ||
      screen?.generation !== after.generation ||
      screen.sequence !== after.outputSequence ||
      screen.codexComposer !== true ||
      detectTerminalWaitBlockedReason(screen.lines.join('\n')) !== null ||
      /would you like to|yes, proceed|approve|approval|allow once|allow always|reject|deny/i.test(
        screen.lines.join('\n')
      )
    ) {
      return
    }
    this.retired.set(record, { ...after, prefix: text })
  }
}
