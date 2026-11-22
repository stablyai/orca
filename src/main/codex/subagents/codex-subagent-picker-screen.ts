// Reads Codex's `/subagents` picker ("Select an agent to watch") off the rendered pane screen.
const PICKER_HINT = 'Select an agent to watch'
const PICKER_ROW =
  /^\s*(›\s*)?(\d+)\.\s.*?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
// Codex's composer placeholder while it watches a sub-agent; transcript text can mention the phrase.
const VIEWING_SUBAGENT = /^\s*›\s+Viewing sub-agent/

export type CodexSubagentPickerRow = { index: number; threadId: string; highlighted: boolean }

/** The picker's rows, or null while it is not on screen. */
export function readCodexSubagentPicker(lines: readonly string[]): CodexSubagentPickerRow[] | null {
  // The live popup is the last hint on screen; only the row block directly under it counts.
  const hint = lines.findLastIndex((line) => line.includes(PICKER_HINT))
  if (hint === -1) {
    return null
  }
  const rows: CodexSubagentPickerRow[] = []
  for (const line of lines.slice(hint + 1)) {
    const match = PICKER_ROW.exec(line)
    if (!match) {
      if (rows.length > 0 || line.trim()) {
        break
      }
      continue
    }
    rows.push({
      index: Number(match[2]),
      threadId: match[3]!.toLowerCase(),
      highlighted: match[1] !== undefined
    })
  }
  return rows.length > 0 ? rows : null
}

export function showsCodexSubagent(lines: readonly string[]): boolean {
  return lines.some((line) => VIEWING_SUBAGENT.test(line))
}

/** Keys that select `row`: its number when Codex binds one, else arrows from the highlight. */
export function codexSubagentPickerKeys(
  rows: readonly CodexSubagentPickerRow[],
  row: CodexSubagentPickerRow
): string | null {
  if (row.index <= 9) {
    return String(row.index)
  }
  const from = rows.find((candidate) => candidate.highlighted)
  if (!from) {
    return null
  }
  const delta = row.index - from.index
  return `${(delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta))}\r`
}
