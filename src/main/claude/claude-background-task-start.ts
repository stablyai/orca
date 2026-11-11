import { isSettledBackgroundTaskState } from '../../shared/native-chat/input/native-chat-background-task-row'
import { classifyClaudeBackgroundTaskKind } from './claude-background-task-frames'
import {
  claudeBackgroundTaskToolUseId,
  isClaudeBackgroundTranscriptTask,
  shouldRestartClaudeBackgroundTaskRow,
  type ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'
import {
  ensureClaudeBackgroundTaskRowSlot,
  type ClaudeBackgroundTaskLedgers
} from './claude-background-task-memory'
import { isClaudeSubagentTask } from './claude-subagent-task-frames'

type ClaudeBackgroundTaskStartInput = {
  id: string
  message: Record<string, unknown>
  rows: Map<string, ClaudeBackgroundTaskRow>
  ledgers: ClaudeBackgroundTaskLedgers
  isForwardedParentTool: (toolUseId: string) => boolean
  openRow: (id: string, message: Record<string, unknown>) => void
  maxRows: number
}

export function observeClaudeBackgroundTaskStart(
  input: ClaudeBackgroundTaskStartInput & {
    owned: boolean
    refresh: (id: string, row: ClaudeBackgroundTaskRow) => void
  }
): boolean {
  const { id, message, rows, ledgers } = input
  if (ledgers.fallbackTaskIds.has(id)) {
    if (ledgers.terminalTaskIds.has(id)) {
      const previousToolUseId = ledgers.terminalToolUseIds.get(id)
      const currentToolUseId = claudeBackgroundTaskToolUseId(message)
      if (
        previousToolUseId !== undefined &&
        currentToolUseId !== undefined &&
        previousToolUseId !== currentToolUseId
      ) {
        ledgers.fallbackTaskIds.delete(id)
      } else {
        return false
      }
    } else {
      return false
    }
  }
  if (isClaudeSubagentTask(message)) {
    ledgers.rememberForeign(id, 'roster')
    return true
  }
  const kind = classifyClaudeBackgroundTaskKind(message.task_type)
  if (!isClaudeBackgroundTranscriptTask(message, kind)) {
    ledgers.rememberForeign(id, 'foreground')
    return true
  }
  const existing = rows.get(id)
  if (existing) {
    ledgers.foreign.delete(id)
    // A live task's duplicate announcement is redelivery, not a new run.
    if (!isSettledBackgroundTaskState(existing.block.state)) {
      input.refresh(id, existing)
      return true
    }
    if (shouldRestartClaudeBackgroundTaskRow(existing, message)) {
      input.openRow(id, message)
    }
    return true
  }
  let restartedTerminal = false
  if (ledgers.terminalTaskIds.has(id)) {
    const previousToolUseId = ledgers.terminalToolUseIds.get(id)
    const currentToolUseId = claudeBackgroundTaskToolUseId(message)
    // A terminal edge without a usable parent cannot prove a later start is a new run.
    if (
      previousToolUseId === undefined ||
      currentToolUseId === undefined ||
      previousToolUseId === currentToolUseId
    ) {
      return true
    }
    restartedTerminal = true
  }
  ledgers.foreign.delete(id)
  const toolUseId = claudeBackgroundTaskToolUseId(message)
  // Absence of a parent is not evidence of an unforwarded parent.
  if (toolUseId !== undefined && !input.owned && !input.isForwardedParentTool(toolUseId)) {
    ledgers.rememberForeign(id, 'sidechain')
    return true
  }
  if (!ensureClaudeBackgroundTaskRowSlot(rows, input.maxRows)) {
    ledgers.rememberFallback(id)
    return false
  }
  if (restartedTerminal) {
    ledgers.terminalTaskIds.delete(id)
    ledgers.terminalToolUseIds.delete(id)
  }
  input.openRow(id, message)
  return true
}
