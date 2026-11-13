import { detectTerminalComposerDraft } from '../../../../shared/terminal/input/terminal-composer-draft'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import {
  readHeadlessActionRows,
  type HeadlessTerminalRow
} from '../../../daemon/emulation/headless-terminal-rows'
import type { RuntimeTerminalRowMetadata } from '../../../../shared/runtime-terminal-contracts'
import {
  getTerminalLineOrigins,
  setTerminalLineOrigins,
  sliceTerminalOrigins,
  type TerminalContentOrigin
} from '../../../../shared/terminal/output/terminal-content-origin'

type TerminalProjectionEmulator = Pick<
  HeadlessEmulator,
  'getBufferTailRows' | 'getVisibleRows' | 'getVisibleBufferRange' | 'getCursorLineContext'
> &
  Partial<Pick<HeadlessEmulator, 'getVisibleActionLines'>>

function projectTerminalRows(
  rows: HeadlessTerminalRow[],
  limit = rows.length
): {
  lines: string[]
  tailRows: RuntimeTerminalRowMetadata[]
} {
  const projected: HeadlessTerminalRow[] = []
  let previous = -2
  rows.forEach((row, index) => {
    if (!row.text.trim()) {
      return
    }
    projected.push({
      text: row.text.trimEnd(),
      origins: row.origins,
      metadata: {
        ...row.metadata,
        trailingSpaces: row.metadata.trailingSpaces + row.text.length - row.text.trimEnd().length,
        wrapped: index === previous + 1 && row.metadata.wrapped
      }
    })
    previous = index
  })
  const kept = projected.slice(-limit)
  const lines = kept.map((row) => row.text)
  if (kept.some((row) => row.origins)) {
    setTerminalLineOrigins(
      lines,
      kept.map((row) => sliceTerminalOrigins(row.origins, 0, row.text.length))
    )
  }
  return {
    lines,
    tailRows: kept.map((row, index) => ({
      ...row.metadata,
      wrapped: index > 0 && row.metadata.wrapped
    }))
  }
}

export function projectTerminalTailLines(
  emulator: TerminalProjectionEmulator,
  limit: number
): { lines: string[]; tailRows: RuntimeTerminalRowMetadata[]; draft?: string } {
  const tail = emulator.getBufferTailRows(limit)
  const visible = emulator.getVisibleRows()
  const visibleRange = emulator.getVisibleBufferRange()
  const draft = detectTerminalComposerDraft(emulator.getCursorLineContext())
  if (draft && visibleRange.endExclusive === visibleRange.totalLength) {
    visible[draft.promptRow] = {
      text: draft.promptGlyph,
      metadata: { wrapped: false, trailingSpaces: 0 }
    }
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      visible[row] = { text: '', metadata: { wrapped: false, trailingSpaces: 0 } }
    }
    const scrollbackTail = tail.slice(0, Math.max(0, tail.length - visible.length))
    tail.splice(0, tail.length, ...scrollbackTail, ...visible)
  }
  return {
    ...projectTerminalRows(tail, limit),
    ...(draft ? { draft: draft.text } : {})
  }
}

const actionProjections = new WeakMap<
  HeadlessTerminalRow[],
  ReturnType<typeof projectTerminalRows> & { draft?: string }
>()

export function projectTerminalVisibleLines(
  emulator: TerminalProjectionEmulator,
  scope?: TerminalContentOrigin
): {
  lines: string[]
  tailRows: RuntimeTerminalRowMetadata[]
  draft?: string
} {
  const source =
    scope && emulator.getVisibleActionLines
      ? readHeadlessActionRows(emulator, emulator.getVisibleActionLines(scope))
      : emulator.getVisibleRows()
  const cached = scope ? actionProjections.get(source) : undefined
  if (cached) {
    return cached
  }
  const visible = source.slice()
  const draft = detectTerminalComposerDraft(emulator.getCursorLineContext())
  if (draft) {
    visible[draft.promptRow] = {
      text: draft.promptGlyph,
      origins: sliceTerminalOrigins(
        visible[draft.promptRow]?.origins,
        Math.max(0, visible[draft.promptRow]?.text.indexOf(draft.promptGlyph) ?? 0),
        Math.max(0, visible[draft.promptRow]?.text.indexOf(draft.promptGlyph) ?? 0) +
          draft.promptGlyph.length
      ),
      metadata: { wrapped: false, trailingSpaces: 0 }
    }
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      visible[row] = { text: '', metadata: { wrapped: false, trailingSpaces: 0 } }
    }
  }
  const projection = {
    ...projectTerminalRows(visible),
    ...(draft ? { draft: draft.text } : {})
  }
  if (scope) {
    actionProjections.set(source, projection)
  }
  return projection
}

const PROJECTED_PROMPT_GLYPHS: ReadonlySet<string> = new Set(['❯', '›', '»'])

/** Restore blanked drafts before rules inspect what the TUI painted. */
export function restoreProjectedComposerDraft(
  lines: readonly string[],
  draft: string | undefined
): string[] {
  const promptRow = draft ? lines.findLastIndex((line) => PROJECTED_PROMPT_GLYPHS.has(line)) : -1
  if (draft === undefined || promptRow === -1) {
    const copy = [...lines]
    const origins = getTerminalLineOrigins(lines)
    if (origins) {
      setTerminalLineOrigins(copy, origins)
    }
    return copy
  }
  const [first = '', ...rest] = draft.split('\n')
  const restored = [
    ...lines.slice(0, promptRow),
    `${lines[promptRow]} ${first}`,
    ...rest,
    ...lines.slice(promptRow + 1)
  ]
  const origins = getTerminalLineOrigins(lines)
  if (origins) {
    setTerminalLineOrigins(restored, [
      ...origins.slice(0, promptRow),
      origins[promptRow] ?? [],
      ...rest.map(() => []),
      ...origins.slice(promptRow + 1)
    ])
  }
  return restored
}
