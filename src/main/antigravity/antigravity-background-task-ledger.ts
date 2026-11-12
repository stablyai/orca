import { basename, join } from 'node:path'
import type { AcpBackgroundTaskUpdate } from '../acp/acp-dialects/acp-dialect'
import type { OpenPromptTool } from './antigravity-reactive-turn-streamer'
import {
  cleanAntigravityToolOutput,
  extractAntigravityCommand,
  parseAntigravityTaskId,
  summarizeAntigravityBgCompletion,
  type AntigravityTranscriptReader,
  type AntigravityTranscriptStep,
  type AntigravityTranscriptToolCall
} from './antigravity-transcript-reader'

/** Track active Antigravity background command tasks and publish deduplicated state transitions. */
export class AntigravityBackgroundTaskLedger {
  private readonly workingTasks = new Map<string, { label: string; parentToolUseId?: string }>()
  private readonly historicalLabels = new Map<string, string>()
  private readonly emittedTaskStates = new Map<string, string>()

  /** Whether one or more background tasks are still running. */
  get hasWorkingTasks(): boolean {
    return this.workingTasks.size > 0
  }

  /** Seed running tasks and reconcile previously persisted recoverable tasks on attach. */
  seedExisting(
    sessionId: string,
    sysDir: string,
    reader: AntigravityTranscriptReader,
    emitTurnUpdate: (params: unknown) => void,
    recoverableTaskIds: ReadonlySet<string> | null = null
  ): void {
    const pendingCalls: AntigravityTranscriptToolCall[] = []
    const sortedEntries = [...reader.stepsByIndex.entries()].sort((a, b) => a[0] - b[0])
    for (const [, step] of sortedEntries) {
      if (step.type === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls)) {
        pendingCalls.push(...step.tool_calls)
      } else if (step.type === 'GENERIC') {
        const call = pendingCalls.shift()
        if (step.status === 'RUNNING') {
          const taskId = parseAntigravityTaskId(sessionId, step)
          const cmd = extractAntigravityCommand(call?.args)
          const summary =
            typeof call?.args?.toolSummary === 'string' ? call.args.toolSummary : undefined
          const label = summary || cmd || taskId
          this.historicalLabels.set(taskId, label)
          if (!reader.settledTasks.has(taskId) && !reader.killedTaskIds.has(taskId)) {
            this.registerWorkingTask(sessionId, sysDir, reader, emitTurnUpdate, taskId, label)
          }
        }
      }
    }
    if (recoverableTaskIds) {
      this.reconcileRecoverable(sessionId, reader, emitTurnUpdate, recoverableTaskIds)
    }
  }

  /** Reconcile persisted non-terminal background-task rows that finished while disconnected. */
  reconcileRecoverable(
    sessionId: string,
    reader: AntigravityTranscriptReader,
    emitTurnUpdate: (params: unknown) => void,
    recoverableTaskIds: ReadonlySet<string>
  ): void {
    for (const taskId of recoverableTaskIds) {
      if (
        !this.workingTasks.has(taskId) &&
        (reader.settledTasks.has(taskId) || reader.killedTaskIds.has(taskId))
      ) {
        this.workingTasks.set(taskId, { label: this.historicalLabels.get(taskId) ?? taskId })
      }
    }
    this.reconcile(sessionId, reader, emitTurnUpdate)
  }

  /** Match open prompt tool calls against newly backgrounded transcript steps and settle them. */
  settlePromptLaunchers(
    sessionId: string,
    sysDir: string,
    reader: AntigravityTranscriptReader,
    openPromptTools: Map<string, OpenPromptTool>,
    settledLauncherCallIds: Set<string>,
    startStepIndex: number,
    endStepIndex: number,
    emit: ((method: string, params: unknown) => void) | null,
    emitTurnUpdate: (params: unknown) => void
  ): void {
    const running: {
      step: AntigravityTranscriptStep
      taskId: string
      command?: string
      label: string
    }[] = []
    const pendingCalls: AntigravityTranscriptToolCall[] = []
    let seenUserInput = false
    for (let idx = startStepIndex; idx <= endStepIndex; idx += 1) {
      const step = reader.stepsByIndex.get(idx)
      if (!step) {
        continue
      }
      if (step.type === 'USER_INPUT') {
        seenUserInput = true
        continue
      }
      if (!seenUserInput) {
        continue
      }
      if (step.type === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls)) {
        pendingCalls.push(...step.tool_calls)
      } else if (step.type === 'GENERIC') {
        const call = pendingCalls.shift()
        if (step.status === 'RUNNING') {
          const taskId = parseAntigravityTaskId(sessionId, step)
          const command = extractAntigravityCommand(call?.args)
          const summary =
            typeof call?.args?.toolSummary === 'string' ? call.args.toolSummary : undefined
          const label = summary || command || taskId
          this.historicalLabels.set(taskId, label)
          running.push({ step, taskId, command, label })
        }
      }
    }
    const claimed = new Set<number>()
    const pairs: [string, (typeof running)[number]][] = []
    const unmatchedExecIds: string[] = []
    for (const [toolCallId, openTool] of openPromptTools) {
      const exact = running.find(
        (r) =>
          !claimed.has(r.step.step_index ?? -1) &&
          openTool.command !== undefined &&
          r.command === openTool.command
      )
      if (exact) {
        claimed.add(exact.step.step_index ?? -1)
        pairs.push([toolCallId, exact])
      } else if (openTool.command !== undefined) {
        unmatchedExecIds.push(toolCallId)
      }
    }
    for (const toolCallId of unmatchedExecIds) {
      const openTool = openPromptTools.get(toolCallId)
      const fallback = running.find(
        (r) =>
          !claimed.has(r.step.step_index ?? -1) &&
          (r.command === undefined || r.command === openTool?.command)
      )
      if (fallback) {
        claimed.add(fallback.step.step_index ?? -1)
        pairs.push([toolCallId, fallback])
      }
    }
    for (const [toolCallId, matched] of pairs) {
      settledLauncherCallIds.add(toolCallId)
      emit?.('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: { output: cleanAntigravityToolOutput(matched.step.content), exitCode: 0 }
        }
      })
      this.registerWorkingTask(
        sessionId,
        sysDir,
        reader,
        emitTurnUpdate,
        matched.taskId,
        matched.label,
        toolCallId
      )
    }
    for (const item of running) {
      if (!claimed.has(item.step.step_index ?? -1)) {
        this.registerWorkingTask(sessionId, sysDir, reader, emitTurnUpdate, item.taskId, item.label)
      }
    }
    for (const [toolCallId] of pairs) {
      openPromptTools.delete(toolCallId)
    }
  }

  /** Record a newly backgrounded command task, emit its `working` state, and reconcile immediate completions. */
  registerWorkingTask(
    sessionId: string,
    sysDir: string,
    reader: AntigravityTranscriptReader,
    emitTurnUpdate: (params: unknown) => void,
    taskId: string,
    label: string,
    parentToolUseId?: string,
    turn?: string
  ): void {
    this.historicalLabels.set(taskId, label)
    this.workingTasks.set(taskId, { label, parentToolUseId })
    const taskLogName = basename(taskId.replaceAll('\\', '/')) || 'task'
    const outputFile = join(sysDir, 'tasks', `${taskLogName}.log`)
    this.emitTask(
      sessionId,
      emitTurnUpdate,
      {
        taskId,
        state: 'working',
        kind: 'command',
        label,
        outputFile,
        ...(parentToolUseId ? { parentToolUseId } : {})
      },
      turn
    )
    this.reconcile(sessionId, reader, emitTurnUpdate)
  }

  /** Transition working tasks to terminal states once completion messages or kill calls appear on disk. */
  reconcile(
    sessionId: string,
    reader: AntigravityTranscriptReader,
    emitTurnUpdate: (params: unknown) => void
  ): void {
    for (const [taskId, info] of this.workingTasks) {
      const msg = reader.settledTasks.get(taskId)
      if (msg) {
        const { state, summary } = summarizeAntigravityBgCompletion(msg.content)
        this.workingTasks.delete(taskId)
        this.emitTask(sessionId, emitTurnUpdate, {
          taskId,
          state,
          kind: 'command',
          label: info.label,
          summary,
          ...(state === 'blocked' ? { error: summary } : {})
        })
      } else if (reader.killedTaskIds.has(taskId)) {
        this.workingTasks.delete(taskId)
        this.emitTask(sessionId, emitTurnUpdate, {
          taskId,
          state: 'idle',
          kind: 'command',
          label: info.label,
          summary: 'Stopped'
        })
      }
    }
  }

  /** Emit a single background-task update unless that exact state was already published for `taskId`. */
  private emitTask(
    sessionId: string,
    emitTurnUpdate: (params: unknown) => void,
    task: AcpBackgroundTaskUpdate,
    turn?: string
  ): void {
    if (this.emittedTaskStates.get(task.taskId) === task.state) {
      return
    }
    this.emittedTaskStates.set(task.taskId, task.state)
    emitTurnUpdate({
      sessionId,
      ...(turn ? { turn } : {}),
      backgroundTasks: [task]
    })
  }
}
