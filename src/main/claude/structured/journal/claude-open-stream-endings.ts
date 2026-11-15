import type { ClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import type { ClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type { ClaudeStreamedThinking } from './claude-streamed-thinking'

/** End streams no final frame will close; a steer hand-off leaves subagent text open until settle. */
export function endClaudeStreams(
  thinking: Pick<ClaudeStreamedThinking, 'finishOpen'>,
  text: Pick<ClaudeStreamedTextCheckpoints, 'finish'>,
  blocks: Pick<ClaudeStreamedBlockRegistry, 'clear'>,
  completedAt: number,
  settles = false
): void {
  thinking.finishOpen(completedAt)
  // A superseded turn's background subagent may keep streaming the same block into the next turn.
  if (!settles) {
    return
  }
  text.finish({ completedAt })
  blocks.clear()
}
