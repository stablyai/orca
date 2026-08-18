import { frameMultilineTerminalPasteText } from '../../../src/shared/terminal-bracketed-paste-bytes'

/**
 * Diff review notes are multi-line prose bound for an agent TUI, so they must
 * arrive as one paste — unframed, each note boundary is an Enter and the notes
 * are submitted a line at a time.
 *
 * The opt-in lives here at the caller, not on the launch seam: that same seam
 * carries insert-only shell quick commands, and framing one of those would
 * corrupt it. The notes are also offered to the clipboard unframed, so the
 * framing cannot move up into where the delivery is built either.
 */
export function buildDiffNotesAgentLaunchPrompt(prompt: string): string {
  return frameMultilineTerminalPasteText(prompt)
}
