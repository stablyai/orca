import type { PaneReadParams, PaneReadResult } from './herdr-socket-types'

// Why: full ANSI/VT escape matcher (CSI, OSC, DCS, APC, and lone ESC runs).
// A single wide regex keeps strip_ansi faithful to what a real terminal drops.
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsiEscape(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '')
}

type PaneReadInput = {
  pane_id: string
  workspace_id: string
  tab_id: string
  buffer: string
  revision: number
  rows: number
  params: PaneReadParams
}

// Why: pane.read serves a window of the pane's raw PTY buffer. The source
// selects how much of the buffer to return and format selects raw vs stripped.
export function buildPaneReadResult(input: PaneReadInput): PaneReadResult {
  const { pane_id, workspace_id, tab_id, buffer, revision, rows, params } = input
  const source = params.source
  const format = params.format ?? 'text'
  const stripAnsi = params.strip_ansi ?? format === 'text'

  // Why: ansi-format reads feed xterm full frames. Rewriting \r to \n reflows
  // cursor-return sequences (zsh/p10k prompts use bare \r constantly) into
  // extra lines, scrambling the rendered screen; keep the raw bytes intact.
  const normalized = format === 'ansi' ? buffer : buffer.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const windowSize = Math.max(
    1,
    source === 'visible' ? rows : (params.lines ?? (source === 'detection' ? 200 : 100))
  )
  const window = lines.slice(-windowSize)
  const raw = window.join('\n')
  const text = stripAnsi ? stripAnsiEscape(raw) : raw

  return {
    pane_id,
    workspace_id,
    tab_id,
    source,
    format,
    text,
    revision,
    truncated: lines.length > windowSize
  }
}
