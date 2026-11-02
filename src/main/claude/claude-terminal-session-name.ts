import { readTranscriptSlice, transcriptFileStat } from '../native-chat/wsl-transcript-fs-access'

// Claude appends `custom-title` on each /rename, so the latest one sits near the end.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/** One line, as `/rename` takes it; null when nothing is left to name. */
export function normalizeClaudeSessionName(name: string | null | undefined): string | null {
  const normalized = name?.replace(/\s+/g, ' ').trim()
  return normalized ? normalized : null
}

export function claudeRenameCommand(name: string): string {
  return `/rename ${name}`
}

/** The name a Claude window title shows, without its one-glyph status prefix (spinner frames share it). */
export function claudeTitleName(title: string): string {
  const shown = title.trim()
  const match = /^(\S{1,2}) +(.+)$/u.exec(shown)
  return match && !/[\p{L}\p{N}]/u.test(match[1]) ? match[2] : shown
}

/** Claude's window title is the session name, optionally behind a one-glyph status prefix. */
export function claudeTitleShowsName(title: string, name: string): boolean {
  return title.trim() === name || claudeTitleName(title) === name
}

/** The session's newest `/rename`, read from the transcript tail; null when it has none yet. */
export function latestClaudeCustomTitle(transcriptTail: string): string | null {
  const lines = transcriptTail.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line?.includes('"custom-title"')) {
      continue
    }
    try {
      const entry: unknown = JSON.parse(line)
      if (
        entry &&
        typeof entry === 'object' &&
        'type' in entry &&
        entry.type === 'custom-title' &&
        'customTitle' in entry &&
        typeof entry.customTitle === 'string'
      ) {
        return normalizeClaudeSessionName(entry.customTitle)
      }
    } catch {
      // A torn or partial line; an earlier rename may still be whole.
    }
  }
  return null
}

export async function readClaudeTranscriptCustomTitle(
  transcriptPath: string
): Promise<string | null> {
  const { size } = await transcriptFileStat(transcriptPath, 'exact')
  if (size === 0) {
    return null
  }
  const position = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
  const tail = await readTranscriptSlice(transcriptPath, position, size - position, 'exact')
  return latestClaudeCustomTitle(tail.toString('utf8'))
}
