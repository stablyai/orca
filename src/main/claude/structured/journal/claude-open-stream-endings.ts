import type { ClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import type { ClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type { ClaudeStreamedThinking } from './claude-streamed-thinking'

/** End streams no final frame will close; a steer hand-off leaves subagent text open until here. */
export function endClaudeStreams(
  thinking: Pick<ClaudeStreamedThinking, 'finishOpen'>,
  text: Pick<ClaudeStreamedTextCheckpoints, 'finish'>,
  blocks: Pick<ClaudeStreamedBlockRegistry, 'clear'>,
  completedAt: number
): void {
  thinking.finishOpen(completedAt)
  text.finish({ completedAt })
  blocks.clear()
}
