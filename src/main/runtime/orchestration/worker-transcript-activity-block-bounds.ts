import {
  normalizeBackgroundTaskKind,
  normalizeBackgroundTaskState
} from '../../../shared/native-chat-background-task-row'
import { normalizeSubagentState } from '../../../shared/native-chat-subagent-summary'
import type { NativeChatBlock, NativeChatSubagentState } from '../../../shared/native-chat-types'

type WorkerTranscriptActivityBlock = Extract<
  NativeChatBlock,
  { type: 'subagent-group' | 'background-task' }
>

export type WorkerTranscriptActivityBlockBounders = {
  clipMetadata: (value: string) => string
  clipText: (value: string) => string
  boundEntryId: (value: string) => string
  markClipped: (warning: string) => void
}

const MAX_WORKER_TRANSCRIPT_SUBAGENTS = 64

export function boundWorkerTranscriptActivityBlock(
  block: WorkerTranscriptActivityBlock,
  bounders: WorkerTranscriptActivityBlockBounders
): NativeChatBlock {
  if (block.type === 'subagent-group') {
    const agents = block.agents.slice(0, MAX_WORKER_TRANSCRIPT_SUBAGENTS)
    if (agents.length < block.agents.length) {
      bounders.markClipped('Some subagents were omitted from oversized spawn groups.')
    }
    return {
      ...block,
      groupId: bounders.clipMetadata(block.groupId),
      agents: agents.map((agent) => ({
        ...agent,
        id: bounders.boundEntryId(agent.id),
        label: bounders.clipMetadata(agent.label),
        state: clipSubagentState(agent.state, bounders)
      }))
    }
  }
  const { outputFile, ...carried } = block
  if (outputFile) {
    bounders.markClipped('Background task output paths were omitted from transcript output.')
  }
  return {
    ...carried,
    taskId: bounders.boundEntryId(block.taskId),
    kind: normalizeBackgroundTaskKind(bounders.clipMetadata(block.kind)),
    label: bounders.clipMetadata(block.label),
    state: normalizeBackgroundTaskState(bounders.clipMetadata(block.state)),
    ...(block.summary ? { summary: bounders.clipText(block.summary) } : {}),
    ...(block.error ? { error: bounders.clipText(block.error) } : {})
  }
}

function clipSubagentState(
  value: NativeChatSubagentState,
  bounders: WorkerTranscriptActivityBlockBounders
): NativeChatSubagentState {
  const clipped = bounders.clipMetadata(value)
  return clipped === value ? value : normalizeSubagentState(clipped)
}
