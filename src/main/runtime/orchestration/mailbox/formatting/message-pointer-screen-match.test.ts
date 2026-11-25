import { describe, expect, it } from 'vitest'
import { formatMessagePointer } from './message-formatting'
import {
  findOrchestrationPointerSpans,
  type ScreenRow
} from '../../../../../shared/orchestration/mailbox/orchestration-pointer-screen-match'

function row(text: string, wrapped = false): ScreenRow {
  return { text, columns: [...text].map((_, index) => index), wrapped }
}

// A TUI's own word wrap: a prompt glyph, then continuation rows indented two cells.
function tuiRows(pointer: string, width: number): ScreenRow[] {
  const rows = [row('❯ ')]
  let line = ' '
  for (const word of pointer.trim().split(' ')) {
    if (line.length + word.length + 1 > width) {
      rows.push(row(line))
      line = ' '
    }
    line += ` ${word}`
  }
  rows.push(row(line), row('  some agent output after it'))
  return rows
}

// The terminal's own soft wrap: no spaces at the breaks.
function softWrappedRows(pointer: string, width: number): ScreenRow[] {
  const text = pointer.trim()
  const rows: ScreenRow[] = []
  for (let start = 0; start < text.length; start += width) {
    rows.push(row(text.slice(start, start + width), start > 0))
  }
  return rows
}

function covered(rows: ScreenRow[]): string {
  return findOrchestrationPointerSpans(rows)
    .map((span) => rows[span.row].text.slice(span.start, span.end))
    .join('')
    .replace(/\s/g, '')
}

const POINTERS = [
  formatMessagePointer(1, 'term_a', 'orca', undefined, 'term_acbc6f0b-1234-4cde-9abc-0123456789ab'),
  formatMessagePointer(3, 'run:run_1', 'orca-dev', undefined, undefined, ['msg_1', 'msg_2']),
  formatMessagePointer(2, 'term_a', 'orca', 'dlv_9', 'term_acbc6f0b-1234-4cde-9abc-0123456789ab')
]

describe('findOrchestrationPointerSpans', () => {
  it('covers every pointer Orca types, however the screen wraps it, and nothing around it', () => {
    // Claude Code draws the `code` spans as styled text, without the backticks.
    for (const pointer of POINTERS.flatMap((typed) => [typed, typed.replaceAll('`', '')])) {
      const expected = pointer.replace(/\s/g, '')
      for (const width of [40, 80, 400]) {
        expect(covered(tuiRows(pointer, width))).toBe(expected)
        expect(covered(softWrappedRows(pointer, width))).toBe(expected)
      }
    }
  })

  it('covers the prompt glyph before a pointer, but not words before one', () => {
    const pointer = POINTERS[0].trim()
    const [prompted] = findOrchestrationPointerSpans([row(`❯ ${pointer}`)])
    expect(prompted).toMatchObject({ start: 0, first: true })
    const [said] = findOrchestrationPointerSpans([row(`Got: ${pointer}`)])
    expect(said).toMatchObject({ start: 'Got: '.length, first: true })
  })

  it('leaves the agent quoting part of a pointer alone', () => {
    expect(
      covered([
        row('I ran orca orchestration check --terminal term_a. You have 1 orchestration message.')
      ])
    ).toBe('')
  })
})
