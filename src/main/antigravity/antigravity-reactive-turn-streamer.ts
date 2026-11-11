import {
  antigravityToolSignature,
  classifyAntigravityToolKind,
  cleanAntigravityToolOutput,
  extractAntigravityCommand,
  parseAntigravityExitCode,
  parseAntigravityTaskId,
  type AntigravitySettledTaskMessage,
  type AntigravityTranscriptReader,
  type AntigravityTranscriptStep,
  type AntigravityTranscriptToolCall
} from './antigravity-transcript-reader'
import type { AntigravityBackgroundTaskLedger } from './antigravity-background-task-ledger'
import {
  AntigravityPromptReplayGuard,
  type OpenPromptTool
} from './antigravity-prompt-replay-guard'

export type { OpenPromptTool }

const REACTIVE_QUIET_DONE_MS = 1_200
const MESSAGE_WAKEUP_GRACE_MS = 2_500
const RUNNING_ONLY_TURN_IDLE_MS = 30_000

/** Synthesize ACP reactive turns from `agy` transcript wakeups and suppress lagging replays. */
export class AntigravityReactiveTurnStreamer {
  activeReactiveTurn: string | null = null
  private reactiveTurnOpened = false
  private readonly pendingReactiveTools: { synId: string; call: AntigravityTranscriptToolCall }[] =
    []
  private readonly guard = new AntigravityPromptReplayGuard()

  /** Open foreground tool calls observed on the ACP wire during the active prompt. */
  get openPromptTools(): Map<string, OpenPromptTool> {
    return this.guard.openPromptTools
  }

  /** Foreground launcher tool-call IDs already settled as background tasks. */
  get settledLauncherCallIds(): Set<string> {
    return this.guard.settledLauncherCallIds
  }

  /** Whether the active prompt has emitted at least one wire `session/update` notification. */
  get hasPromptWireActivity(): boolean {
    return this.guard.hasPromptWireActivity
  }

  /** Close any open reactive turn and arm replay deduplication before a user `session/prompt`. */
  beginPrompt(sessionId: string, emitTurn: (params: unknown) => void): void {
    if (this.activeReactiveTurn && this.reactiveTurnOpened) {
      emitTurn({ sessionId, turn: this.activeReactiveTurn, end: { stopReason: 'end_turn' } })
    }
    this.activeReactiveTurn = null
    this.reactiveTurnOpened = false
    this.pendingReactiveTools.length = 0
    this.guard.armForPrompt()
  }

  /** Clear buffered reactive signatures and prompt wire tracking once a prompt finishes or aborts. */
  clearPromptCatchup(): void {
    this.guard.clearPromptCatchup()
  }

  /** Return the last transcript step owned by the foreground prompt before any undelivered wakeup. */
  findPromptOwnedEnd(reader: AntigravityTranscriptReader, prePromptStepIndex: number): number {
    return this.guard.findPromptOwnedEnd(reader, prePromptStepIndex)
  }

  /** Track open prompt tools and drop duplicate updates replayed from earlier reactive turns. */
  filterNotification(method: string, params: unknown, inPrompt: boolean): boolean {
    return this.guard.filterNotification(method, params, inPrompt)
  }

  /** Project a newly appended transcript step into synthetic ACP `session/update` frames. */
  processStep(
    ctx: {
      sessionId: string
      sysDir: string
      reader: AntigravityTranscriptReader
      ledger: AntigravityBackgroundTaskLedger
      emit: (method: string, params: unknown) => void
      emitTurn: (params: unknown) => void
    },
    stepIndex: number,
    step: AntigravityTranscriptStep
  ): void {
    if (step.type === 'SYSTEM_MESSAGE') {
      if (!this.activeReactiveTurn) {
        this.activeReactiveTurn = `agy-reactive:${stepIndex}`
        this.reactiveTurnOpened = false
      }
      return
    }
    if (step.type === 'PLANNER_RESPONSE') {
      const turn = this.ensureTurn(stepIndex)
      if (step.thinking?.trim()) {
        this.guard.recordReactiveThought(step.thinking.trim())
        ctx.emit('session/update', {
          sessionId: ctx.sessionId,
          _meta: { agyTurn: turn },
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: step.thinking }
          }
        })
      }
      step.tool_calls?.forEach((call, callIdx) => {
        const synId = `agy_bg_step_${stepIndex}_${callIdx}`
        const args = call.args ?? {}
        const kind = classifyAntigravityToolKind(call.name)
        const isExec = kind === 'execute'
        const title = isExec
          ? (typeof args.toolSummary === 'string' && args.toolSummary.trim()) ||
            extractAntigravityCommand(args) ||
            'Execute command'
          : call.name || 'tool'
        this.guard.recordReactiveToolSig(antigravityToolSignature(kind, call.name, args))
        this.pendingReactiveTools.push({ synId, call })
        ctx.emit('session/update', {
          sessionId: ctx.sessionId,
          _meta: { agyTurn: turn },
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: synId,
            kind,
            ...(isExec ? {} : { name: call.name ?? 'tool' }),
            title,
            status: 'in_progress',
            rawInput: args
          }
        })
      })
      if (step.content?.trim()) {
        this.guard.recordReactiveMessage(step.content.trim())
        ctx.emit('session/update', {
          sessionId: ctx.sessionId,
          _meta: { agyTurn: turn },
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: step.content }
          }
        })
      }
      return
    }
    if (step.type !== 'GENERIC') {
      return
    }
    const pending = this.pendingReactiveTools.shift()
    if (!pending) {
      return
    }
    const turn = this.ensureTurn(stepIndex)
    const output = cleanAntigravityToolOutput(step.content)
    if (step.status === 'RUNNING') {
      const taskId = parseAntigravityTaskId(ctx.sessionId, step)
      const cmd = extractAntigravityCommand(pending.call.args)
      const summary =
        typeof pending.call.args?.toolSummary === 'string'
          ? pending.call.args.toolSummary
          : undefined
      ctx.emit('session/update', {
        sessionId: ctx.sessionId,
        _meta: { agyTurn: turn },
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: pending.synId,
          status: 'completed',
          rawOutput: { output, exitCode: 0 }
        }
      })
      ctx.ledger.registerWorkingTask(
        ctx.sessionId,
        ctx.sysDir,
        ctx.reader,
        ctx.emitTurn,
        taskId,
        summary || cmd || taskId,
        pending.synId,
        turn
      )
      return
    }
    const exitCode = parseAntigravityExitCode(step.content)
    const failed = step.status === 'ERROR' || (exitCode !== undefined && exitCode !== 0)
    ctx.emit('session/update', {
      sessionId: ctx.sessionId,
      _meta: { agyTurn: turn },
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: pending.synId,
        status: failed ? 'failed' : 'completed',
        rawOutput: { output, ...(exitCode !== undefined ? { exitCode } : {}) }
      }
    })
  }

  /** Close an open reactive turn once the planner finishes and the transcript stays quiet. */
  maybeCloseTurn(
    sessionId: string,
    reader: AntigravityTranscriptReader,
    emitTurn: (params: unknown) => void,
    now: number,
    quietThreshold = REACTIVE_QUIET_DONE_MS
  ): void {
    if (!this.activeReactiveTurn || !this.reactiveTurnOpened || this.pendingReactiveTools.length) {
      return
    }
    const last = reader.stepsByIndex.get(reader.maxStepIndex)
    if (!last) {
      return
    }
    for (const msg of reader.settledTasks.values()) {
      if (now - msg.mtimeMs < MESSAGE_WAKEUP_GRACE_MS && !hasSystemAfterTask(reader, msg)) {
        return
      }
    }
    const quietMs = now - reader.transcriptMtimeMs
    const plannerDone =
      last.type === 'PLANNER_RESPONSE' &&
      last.status === 'DONE' &&
      (!Array.isArray(last.tool_calls) || last.tool_calls.length === 0)
    const runningOnlyDone =
      last.type === 'GENERIC' && last.status === 'RUNNING' && quietMs >= RUNNING_ONLY_TURN_IDLE_MS
    if ((plannerDone && quietMs >= quietThreshold) || runningOnlyDone) {
      emitTurn({ sessionId, turn: this.activeReactiveTurn, end: { stopReason: 'end_turn' } })
      this.activeReactiveTurn = null
      this.reactiveTurnOpened = false
    }
  }

  /** Lazily allocate a synthetic reactive turn identifier for `stepIndex`. */
  private ensureTurn(stepIndex: number): string {
    this.activeReactiveTurn ??= `agy-reactive:${stepIndex}`
    this.reactiveTurnOpened = true
    return this.activeReactiveTurn
  }
}

/** Check whether a `SYSTEM_MESSAGE` wakeup has already arrived after `msg`'s launcher step. */
function hasSystemAfterTask(
  reader: AntigravityTranscriptReader,
  msg: AntigravitySettledTaskMessage
): boolean {
  for (let idx = reader.maxStepIndex; idx > (msg.stepIndex ?? 0); idx -= 1) {
    if (reader.stepsByIndex.get(idx)?.type === 'SYSTEM_MESSAGE') {
      return true
    }
  }
  return false
}
