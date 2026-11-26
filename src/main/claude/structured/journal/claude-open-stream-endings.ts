import type { ClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import type { ClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type { ClaudeStreamedThinking } from './claude-streamed-thinking'

/** End streams no final frame will close; a hand-off preserves continuing subagent streams. */
export function endClaudeStreams(
  thinking: Pick<ClaudeStreamedThinking, 'finishOpen' | 'finishRoot'>,
  text: Pick<ClaudeStreamedTextCheckpoints, 'finish' | 'finishRoot'>,
  blocks: Pick<ClaudeStreamedBlockRegistry, 'clear' | 'clearScope'>,
  sessionId: string | null,
  completedAt: number,
  settles = false
): void {
  if (!settles) {
    text.finishRoot({ completedAt })
    if (sessionId !== null) {
      blocks.clearScope(sessionId, null)
      thinking.finishRoot(sessionId, completedAt)
    }
    return
  }
  thinking.finishOpen(completedAt)
  text.finish({ completedAt })
  blocks.clear()
}
