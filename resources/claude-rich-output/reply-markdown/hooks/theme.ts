import type { Switch } from './blocks'

// Charmtone (the palette of Charm's tools), one hue per kind of thing; change
// these to restyle. `ink` is the text on the `h1` badge, as in Glow.
export const COLOR = {
  h1: '#6b50ff',
  h2: '#ff60ff',
  h3: '#00a4ff',
  h4: '#ff985a',
  bullet: '#00ffb2',
  number: '#e8fe96',
  rule: '#605f6b',
  // A `rules` table's line under its header (Squid), and the faint one
  // between its rows (Iron, the theme's prompt border).
  headRule: '#858392',
  rowRule: '#4d4c57',
  quote: '#ff60ff',
  ink: '#e8fe96'
} as const
// The `/config` switch of each kind of block the mod restyles. A block whose
// switch is off goes back to the engine as the markdown it was written as.
// What Claude reads in its system prompt, so that it writes the forms the mod
// draws only when Claude chooses to. A form switched off is not told.
export function forms(off: ReadonlySet<Switch>) {
  const lines = [
    !off.has('callouts') &&
      'For a warning or a note the user must not miss, write a GitHub alert: a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. It becomes a colored box.',
    !off.has('lists') && 'For steps or checks to tick off, write a task list: `- [ ]` and `- [x]`.',
    !off.has('codeCards') &&
      'Put a command or snippet the user will copy in a code fence of its own, with its language, not in inline code: the fence gets a copy button.'
  ].filter((line) => line !== false)

  return lines.length === 0
    ? undefined
    : [
        'Formatting:',
        '',
        'The reply-markdown mod draws these forms in the terminal, so use them where they fit.',
        ...lines
      ].join('\n')
}
// GitHub's five alerts, `> [!NOTE]` and the rest, in the palette's hues.
export const CALLOUT: Record<string, { label: string; color: string }> = {
  NOTE: { label: 'Note', color: '#00a4ff' },
  TIP: { label: 'Tip', color: '#00ffb2' },
  IMPORTANT: { label: 'Important', color: '#8b75ff' },
  WARNING: { label: 'Warning', color: '#f5ef34' },
  CAUTION: { label: 'Caution', color: '#ff577d' }
}
export const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i
export const TASK = /^\[([ xX])\][ \t]+([\s\S]*)$/
// ponytail: the bar beside a quote, and between a table's cells, is this
// many rows, clipped to what it stands beside; anything taller runs out of bar.
export const bar = (glyph: string) => Array(200).fill(glyph).join('\n')
export const BAR = bar('│')
// A table's frame by border style, under the names the engine's own Box
// takes: the corners and joints of its three edges, then its two lines.
// Thick lines have square corners only: Unicode has no heavy arc. `rules`,
// the default, has no frame: a line under the header and between the rows.
export const FRAME: Record<string, { edges: [string, string, string]; line: string; bar: string }> =
  {
    round: { edges: ['╭┬╮', '├┼┤', '╰┴╯'], line: '─', bar: '│' },
    single: { edges: ['┌┬┐', '├┼┤', '└┴┘'], line: '─', bar: '│' },
    bold: { edges: ['┏┳┓', '┣╋┫', '┗┻┛'], line: '━', bar: '┃' }
  }
