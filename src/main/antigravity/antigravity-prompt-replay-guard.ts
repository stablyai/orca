import { z } from 'zod'
import {
  antigravityToolSignature,
  classifyAntigravityToolKind,
  extractAntigravityCommand,
  type AntigravityTranscriptReader,
  type AntigravityTranscriptStep
} from './antigravity-transcript-reader'
import {
  appendBoundedRunText,
  consumeBoundedTextRun,
  consumeLaggingSequenceText,
  type BoundedTextRun,
  type PendingLaggingItem
} from './antigravity-wire-planner-segment'

const MAX_PENDING_REPLAY_ENTRIES = 256

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
  }),
  _meta: z.looseObject({ isReplay: z.boolean().optional() }).nullish()
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
  private readonly pendingLaggingSequence: PendingLaggingItem[] = []
  private laggingOverflowed = false
  private readonly wireThoughtSegments: BoundedTextRun[] = []
  private readonly wireMessageSegments: BoundedTextRun[] = []
  private readonly wireToolSigs: string[] = []
  private lastWirePhase: 'thought' | 'message' | 'tool' | null = null
  hasPromptWireActivity = false
  laggingWindowOpen = false

  /** Reset foreground tracking and arm lagging-replay suppression before a prompt begins. */
  armForPrompt(): void {
    this.openPromptTools.clear()
    this.resetWireTracking()
    this.laggingWindowOpen = !this.laggingOverflowed && this.pendingLaggingSequence.length > 0
  }

  /** Clear buffered reactive signatures and prompt wire state when a prompt finishes or aborts. */
  clearPromptCatchup(): void {
    this.pendingLaggingSequence.length = 0
    this.laggingOverflowed = false
    this.resetWireTracking()
    this.laggingWindowOpen = false
  }

  recordReactiveThought(trimmed: string): void {
    if (trimmed) {
      this.pushPendingLagging({ kind: 'thought', text: trimmed })
    }
  }

  recordReactiveMessage(trimmed: string): void {
    if (trimmed) {
      this.pushPendingLagging({ kind: 'message', text: trimmed })
    }
  }

  recordReactiveToolSig(sig: string): void {
    this.pushPendingLagging({ kind: 'tool', sig })
  }

  /** Return the last transcript step owned by the foreground prompt before any undelivered wakeup. */
  findPromptOwnedEnd(
    reader: AntigravityTranscriptReader,
    prePromptStepIndex: number,
    aborted = false
  ): number {
    const state = {
      thoughts: this.wireThoughtSegments.map((r) => ({ ...r })),
      messages: this.wireMessageSegments.map((r) => ({ ...r })),
      tools: [...this.wireToolSigs]
    }
    let seenForegroundUserInput = false
    let inWakeup = false
    for (let idx = prePromptStepIndex + 1; idx <= reader.maxStepIndex; idx += 1) {
      const step = reader.stepsByIndex.get(idx)
      if (!step) {
        if (reader.rejectedStepIndices.has(idx)) {
          continue
        }
        return idx - 1
      }
      if (step.type === 'USER_INPUT') {
        seenForegroundUserInput = true
        inWakeup = false
        continue
      }
      if (step.type === 'PLANNER_RESPONSE') {
        if (consumeDeliveredStep(step, state)) {
          continue
        }
        if (aborted && seenForegroundUserInput && !inWakeup) {
          continue
        }
        return idx - 1
      } else if (step.type === 'SYSTEM_MESSAGE') {
        inWakeup = true
        let nextPlanner: AntigravityTranscriptStep | undefined
        for (let after = idx + 1; after <= reader.maxStepIndex; after += 1) {
          const later = reader.stepsByIndex.get(after)
          if (later?.type === 'PLANNER_RESPONSE') {
            nextPlanner = later
            break
          }
        }
        const probe = {
          thoughts: state.thoughts.map((r) => ({ ...r })),
          messages: state.messages.map((r) => ({ ...r })),
          tools: [...state.tools]
        }
        if (!nextPlanner || !consumeDeliveredStep(nextPlanner, probe)) {
          return idx - 1
        }
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
    const { update, _meta } = parsed.data
    const isExplicitReplay = _meta?.isReplay === true
    const { sessionUpdate: kind, toolCallId, status, rawInput } = update
    if ((kind === 'tool_call' || kind === 'tool_call_update') && toolCallId) {
      if (this.suppressedCallIds.has(toolCallId) || this.settledLauncherCallIds.has(toolCallId)) {
        return false
      }
      const sig = antigravityToolSignature(update.kind, update.name, rawInput)
      if (inPrompt && this.laggingWindowOpen && kind === 'tool_call') {
        const head = this.pendingLaggingSequence[0]
        if (
          head?.kind === 'tool' &&
          head.sig === sig &&
          (isExplicitReplay || !this.hasPromptWireActivity)
        ) {
          this.pendingLaggingSequence.shift()
          this.suppressedCallIds.add(toolCallId)
          this.laggingWindowOpen = this.pendingLaggingSequence.length > 0
          return false
        }
        this.laggingWindowOpen = false
      }
      if (inPrompt) {
        this.hasPromptWireActivity = true
        if (kind === 'tool_call') {
          this.wireToolSigs.push(sig)
          this.lastWirePhase = 'tool'
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
    const targetKind =
      kind === 'agent_message_chunk' ? 'message' : kind === 'agent_thought_chunk' ? 'thought' : null
    if (inPrompt && this.laggingWindowOpen && rawText && targetKind) {
      if (!rawText.trim()) {
        return false
      }
      if (consumeLaggingSequenceText(this.pendingLaggingSequence, targetKind, rawText)) {
        this.laggingWindowOpen = this.pendingLaggingSequence.length > 0
        return false
      }
      this.laggingWindowOpen = false
    }
    if (inPrompt && rawText && targetKind) {
      this.hasPromptWireActivity = true
      const runs = targetKind === 'thought' ? this.wireThoughtSegments : this.wireMessageSegments
      if (this.lastWirePhase !== targetKind || runs.length === 0) {
        runs.push(
          appendBoundedRunText({ head: '', tail: '', totalLen: 0, consumedOffset: 0 }, rawText)
        )
        this.lastWirePhase = targetKind
      } else {
        runs[runs.length - 1] = appendBoundedRunText(runs.at(-1)!, rawText)
      }
    }
    return true
  }

  private resetWireTracking(): void {
    this.wireThoughtSegments.length = 0
    this.wireMessageSegments.length = 0
    this.wireToolSigs.length = 0
    this.lastWirePhase = null
    this.hasPromptWireActivity = false
  }

  private pushPendingLagging(item: PendingLaggingItem): void {
    if (this.laggingOverflowed) {
      return
    }
    if (this.pendingLaggingSequence.length >= MAX_PENDING_REPLAY_ENTRIES) {
      this.pendingLaggingSequence.length = 0
      this.laggingOverflowed = true
      this.laggingWindowOpen = false
      return
    }
    this.pendingLaggingSequence.push(item)
  }
}

function consumeDeliveredStep(
  step: AntigravityTranscriptStep,
  state: { thoughts: BoundedTextRun[]; messages: BoundedTextRun[]; tools: string[] }
): boolean {
  const wantThought = step.thinking?.trim() ?? ''
  const wantMessage = step.content?.trim() ?? ''
  const wantTools = (step.tool_calls ?? []).map((call) =>
    antigravityToolSignature(classifyAntigravityToolKind(call.name), call.name, call.args)
  )
  if (!wantThought && !wantMessage && wantTools.length === 0) {
    return false
  }
  if (wantThought && !consumeBoundedTextRun(state.thoughts, wantThought)) {
    return false
  }
  if (wantMessage && !consumeBoundedTextRun(state.messages, wantMessage)) {
    return false
  }
  for (const sig of wantTools) {
    const pos = state.tools.indexOf(sig)
    if (pos === -1) {
      return false
    }
    state.tools.splice(pos, 1)
  }
  return true
}
