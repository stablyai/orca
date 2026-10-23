import { readNativeChatTranscriptTailFile } from '../native-chat/transcript-tail-reader'

/** Follows the exact prompt across compaction; unrelated human entries prove nothing. */
export async function isClaudeHumanReply(
  transcriptPath: string,
  promptId: string,
  signal?: AbortSignal,
  onRead?: (bytes: number) => void
): Promise<boolean> {
  let found = false
  let human = false
  let seenPrompt = false
  let crossedTurn = false
  try {
    await readNativeChatTranscriptTailFile(
      transcriptPath,
      0,
      (line) => {
        const entry: unknown = JSON.parse(line)
        if (
          !entry ||
          typeof entry !== 'object' ||
          !('promptId' in entry) ||
          typeof entry.promptId !== 'string'
        ) {
          return null
        }
        if (entry.promptId !== promptId) {
          crossedTurn = seenPrompt
          return null
        }
        seenPrompt = true
        if (
          !('type' in entry) ||
          entry.type !== 'user' ||
          !('origin' in entry) ||
          !entry.origin ||
          typeof entry.origin !== 'object'
        ) {
          return null
        }
        found = true
        human = 'kind' in entry.origin && entry.origin.kind === 'human'
        return null
      },
      false,
      undefined,
      undefined,
      signal,
      undefined,
      { stop: () => found || crossedTurn, onRead }
    )
  } catch {
    return false
  }
  return found && human
}
