/** A footer/title dot must not trigger the agent-row separator; same-length edits preserve captured read timing. */

import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'

const OPENCODE_2_STARTS = [
  'opencode-2-0-14-timed-cold-standalone',
  'opencode-2-0-18-timed-boot-hidden-pane',
  'opencode-2-0-21-timed-cold-standalone',
  'opencode-2-0-21-timed-cold-standalone-hidden-pane',
  'opencode-2-0-21-timed-natural-load-enter-dropped',
  'opencode-2-0-21-timed-enter-after-agent-row',
  'opencode-cmd-2-0-21-timed-warm-server'
]
const TAB_STRIP_STARTS = [
  'opencode-2-0-21-timed-natural-load-enter-dropped',
  'opencode-2-0-21-timed-enter-after-agent-row'
]
const ALT_SCREEN_ENTER = '\x1b[?1049h'
const SGR = '(?:\\x1b\\[[0-9;:]*m)*'
const FOOTER_DIRECTORY = 'col·lecció'

function readyRead(chunks: readonly string[]): number {
  const scanner = createDraftPasteReadyScanner('opencode-agent-row')
  return chunks.findIndex((chunk) => scanner.observe(chunk).ready)
}

function overwrite(chunks: readonly string[], offset: number, text: string): string[] {
  const data = chunks.join('')
  const edited = data.slice(0, offset) + text + data.slice(offset + text.length)
  let start = 0
  return chunks.map((chunk) => edited.slice(start, (start += chunk.length)))
}

function readAt(chunks: readonly string[], offset: number): number {
  let end = 0
  return chunks.findIndex((chunk) => (end += chunk.length) > offset)
}

function footerDirectoryOffset(data: string): number {
  const alt = data.indexOf(ALT_SCREEN_ENTER)
  const corner = new RegExp(`\\x1b\\[(\\d+);\\d+H${SGR}\\u2579`, 'g')
  corner.lastIndex = alt
  const cornerRow = Number(corner.exec(data)![1])
  const path = new RegExp(`\\x1b\\[${cornerRow + 1};\\d+H${SGR}(?:~|/[^/\\x1b]+)/`, 'g')
  path.lastIndex = alt
  const match = path.exec(data)!
  return match.index + match[0].length
}

function tabTitleCharOffset(data: string): number {
  const title = new RegExp(`\\x1b\\[1;\\d+H${SGR}(?=[A-Za-z])`, 'g')
  title.lastIndex = data.indexOf(ALT_SCREEN_ENTER)
  const match = title.exec(data)!
  return match.index + match[0].length
}

describe('a separator OpenCode draws off the agent row does not make it ready', () => {
  it.each(OPENCODE_2_STARTS)('%s: a footer path with a `·` in it', (name) => {
    const { chunks } = readTimedRuntimeFixture(name)
    const data = chunks.join('')
    const at = footerDirectoryOffset(data)
    expect(data.slice(at, at + FOOTER_DIRECTORY.length)).toMatch(/^[\w./-]+$/)
    const edited = overwrite(chunks, at, FOOTER_DIRECTORY)
    expect(readAt(edited, at)).toBeLessThan(readyRead(chunks))
    expect(readyRead(edited)).toBe(readyRead(chunks))
  })

  it.each(TAB_STRIP_STARTS)('%s: a session tab title with a `·` in it', (name) => {
    const { chunks } = readTimedRuntimeFixture(name)
    const at = tabTitleCharOffset(chunks.join(''))
    const edited = overwrite(chunks, at, '·')
    expect(readAt(edited, at)).toBeLessThan(readyRead(chunks))
    expect(readyRead(edited)).toBe(readyRead(chunks))
  })
})
