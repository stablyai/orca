import { z } from 'zod'
import {
  antigravityToolSignature,
  classifyAntigravityToolKind,
  extractAntigravityCommand,
  type AntigravityTranscriptReader,
  type AntigravityTranscriptStep
} from './antigravity-transcript-reader'

const MAX_WIRE_TEXT_BUFFER = 65_536

const messageContentSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional()
})

const sessionUpdateEnvelopeSchema = z.looseObject({
  update: z.looseObject({
    sessionUpdate: z.string(),
    toolCallId: z.string().optional(),
    status: z.string().optional(),
    kind: z.string().optional(),
    name: z.string().optional(),
    rawInput: z.record(z.string(), z.unknown()).optional(),
    content: z.unknown().optional()
  })
})

export type OpenPromptTool = {
  toolCallId: string
  command?: string
  rawInput?: Record<string, unknown>
}

/** Deduplicate lagging ACP replay updates and track foreground prompt step ownership. */
export class AntigravityPromptReplayGuard {
  readonly openPromptTools = new Map<string, OpenPromptTool>()
  readonly settledLauncherCallIds = new Set<string>()
  private readonly suppressedCallIds = new Set<string>()
  private readonly pendingLaggingToolSigs: string[] = []
  private readonly pendingLaggingMessages = new Set<string>()
  private readonly pendingLaggingThoughts = new Set<string>()
  private promptWireText = ''
  private readonly promptWireToolSigs: string[] = []
  hasPromptWireActivity = false
  laggingWindowOpen = false

  /** Reset foreground tracking and arm lagging-replay suppression before a prompt begins. */
  armForPrompt(): void {
    this.openPromptTools.clear()
    this.promptWireText = ''
    this.promptWireToolSigs.length = 0
    this.hasPromptWireActivity = false
    this.laggingWindowOpen =
      this.pendingLaggingToolSigs.length > 0 ||
      this.pendingLaggingMessages.size > 0 ||
      this.pendingLaggingThoughts.size > 0
  }

  /** Clear buffered reactive signatures and prompt wire state when a prompt finishes or aborts. */
  clearPromptCatchup(): void {
    this.pendingLaggingToolSigs.length = 0
    this.pendingLaggingMessages.clear()
    this.pendingLaggingThoughts.clear()
    this.promptWireText = ''
    this.promptWireToolSigs.length = 0
    this.hasPromptWireActivity = false
    this.laggingWindowOpen = false
  }

  /** Record a reactive thought chunk so a subsequent lagging ACP replay can be suppressed. */
  recordReactiveThought(trimmed: string): void {
    this.pendingLaggingThoughts.add(trimmed)
  }

  /** Record a reactive message chunk so a subsequent lagging ACP replay can be suppressed. */
  recordReactiveMessage(trimmed: string): void {
    this.pendingLaggingMessages.add(trimmed)
  }

  /** Record a reactive tool signature so a subsequent lagging ACP replay can be suppressed. */
  recordReactiveToolSig(sig: string): void {
    this.pendingLaggingToolSigs.push(sig)
  }

  /** Return the last transcript step owned by the foreground prompt before any undelivered wakeup. */
  findPromptOwnedEnd(reader: AntigravityTranscriptReader, prePromptStepIndex: number): number {
    let remainingText = this.promptWireText
    const remainingTools = [...this.promptWireToolSigs]
    for (let idx = prePromptStepIndex + 1; idx <= reader.maxStepIndex; idx += 1) {
      const step = reader.stepsByIndex.get(idx)
      if (!step) {
        continue
      }
      if (step.type === 'PLANNER_RESPONSE') {
        remainingText = consumeDeliveredStep(step, remainingText, remainingTools).nextText
        continue
      }
      if (step.type !== 'SYSTEM_MESSAGE') {
        continue
      }
      let deliveredAfter = false
      for (let after = idx + 1; after <= reader.maxStepIndex; after += 1) {
        const later = reader.stepsByIndex.get(after)
        if (
          later?.type === 'PLANNER_RESPONSE' &&
          consumeDeliveredStep(later, remainingText, [...remainingTools]).matched
        ) {
          deliveredAfter = true
          break
        }
      }
      if (!deliveredAfter) {
        return idx - 1
      }
    }
    return reader.maxStepIndex
  }

  /** Track open prompt tools and drop duplicate updates replayed from earlier reactive turns. */
  filterNotification(method: string, params: unknown, inPrompt: boolean): boolean {
    if (method !== 'session/update') {
      return true
    }
    const parsed = sessionUpdateEnvelopeSchema.safeParse(params)
    if (!parsed.success) {
      return true
    }
    const { update } = parsed.data
    const { sessionUpdate: kind, toolCallId, status, rawInput } = update
    if ((kind === 'tool_call' || kind === 'tool_call_update') && toolCallId) {
      if (this.suppressedCallIds.has(toolCallId) || this.settledLauncherCallIds.has(toolCallId)) {
        return false
      }
      const sig = antigravityToolSignature(update.kind, update.name, rawInput)
      if (inPrompt && this.laggingWindowOpen && kind === 'tool_call') {
        const idx = this.pendingLaggingToolSigs.indexOf(sig)
        if (idx !== -1) {
          this.pendingLaggingToolSigs.splice(idx, 1)
          this.suppressedCallIds.add(toolCallId)
          return false
        }
        this.laggingWindowOpen = false
      }
      if (inPrompt) {
        this.hasPromptWireActivity = true
        if (kind === 'tool_call') {
          this.promptWireToolSigs.push(sig)
        }
        if (status === 'completed' || status === 'failed') {
          this.openPromptTools.delete(toolCallId)
        } else if (status === 'pending' || status === 'in_progress' || !status) {
          const prev = this.openPromptTools.get(toolCallId)
          this.openPromptTools.set(toolCallId, {
            toolCallId,
            command: extractAntigravityCommand(rawInput) ?? prev?.command,
            rawInput: rawInput ?? prev?.rawInput
          })
        }
      }
      return true
    }
    const msgContent =
      kind === 'agent_message_chunk' || kind === 'agent_thought_chunk'
        ? messageContentSchema.safeParse(update.content)
        : null
    const rawText =
      msgContent?.success && msgContent.data.type === 'text' && msgContent.data.text
        ? msgContent.data.text
        : ''
    const chunkText = rawText.trim()
    if (inPrompt && this.laggingWindowOpen && chunkText) {
      if (kind === 'agent_message_chunk' && this.pendingLaggingMessages.has(chunkText)) {
        this.pendingLaggingMessages.delete(chunkText)
        return false
      }
      if (kind === 'agent_thought_chunk' && this.pendingLaggingThoughts.has(chunkText)) {
        this.pendingLaggingThoughts.delete(chunkText)
        return false
      }
      this.laggingWindowOpen = false
    }
    if (inPrompt && rawText) {
      this.hasPromptWireActivity = true
      this.promptWireText = (this.promptWireText + rawText).slice(-MAX_WIRE_TEXT_BUFFER)
    }
    return true
  }
}

/** Match and consume a planner step against buffered foreground wire text and tool signatures. */
function consumeDeliveredStep(
  step: AntigravityTranscriptStep,
  textBuffer: string,
  toolSigs: string[]
): { matched: boolean; nextText: string } {
  let matched = false
  let nextText = textBuffer
  for (const raw of [step.thinking, step.content]) {
    const trimmed = raw?.trim()
    if (trimmed) {
      const pos = nextText.indexOf(trimmed)
      if (pos !== -1) {
        matched = true
        nextText = nextText.slice(pos + trimmed.length)
      }
    }
  }
  for (const call of step.tool_calls ?? []) {
    const sig = antigravityToolSignature(
      classifyAntigravityToolKind(call.name),
      call.name,
      call.args
    )
    const idx = toolSigs.indexOf(sig)
    if (idx !== -1) {
      matched = true
      toolSigs.splice(idx, 1)
    }
  }
  return { matched, nextText }
}
