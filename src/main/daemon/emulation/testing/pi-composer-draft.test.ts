import { describe, expect, it } from 'vitest'
import { piComposerHoldsDraft } from '../../../../shared/terminal/input/pi-composer'
import { readTerminalComposerTypedText } from '../../../../shared/terminal/input/terminal-composer-draft'
import type { TerminalCursorContext } from '../../../../shared/terminal/input/terminal-composer-draft'
import { HeadlessEmulator } from '../headless-emulator'
import { readRuntimeFixture } from '../../../runtime/terminal/wait/agent-transcript-replay-test-harness'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../../runtime/terminal/wait/agent-transcript-pane-test-harness'

async function fixtureContext(fixture: string): Promise<TerminalCursorContext> {
  const emulator = new HeadlessEmulator({ cols: 100, rows: 30 })
  try {
    await emulator.write(readRuntimeFixture(fixture))
    const context = emulator.getCursorLineContext()
    if (!context) {
      throw new Error(`no cursor context for ${fixture}`)
    }
    return context
  } finally {
    emulator.dispose()
  }
}

const RULE = '─'.repeat(40)
const WORKING = `── ⠸ Working... ${'─'.repeat(30)}`

function editor(above: string[], cursorRow: string, below: string[]): TerminalCursorContext {
  const rows = [...above, cursorRow]
  return {
    rows,
    typedRows: rows,
    promptGlyphBoldRows: rows.map(() => false),
    rowsBelow: below,
    typedRowsBelow: below,
    beforeCursor: cursorRow,
    afterCursor: '',
    rawAfterCursor: '',
    cursorHidden: true,
    cursorViewportRow: rows.length - 1
  }
}

describe('piComposerHoldsDraft', () => {
  it.each([
    ['pi-1-6-composer-empty', false],
    ['pi-1-6-composer-draft', true],
    ['pi-1-6-composer-draft-wrapped', true]
  ])('reads recorded %s as a draft: %s', async (fixture, held) => {
    const context = await fixtureContext(fixture)
    // The generic reader needs a prompt glyph, which Pi never draws (#45901).
    expect(readTerminalComposerTypedText(context)).toBeFalsy()
    expect(piComposerHoldsDraft(context)).toBe(held)
  })

  // Pi 1.6 writes scroll markers into the rules and its working status into the top rule.
  it.each([
    ['text only below the cursor', editor([RULE], '', ['second line', RULE])],
    [
      'a scrolled editor',
      editor(['─────── ↑ 2 more ───────', 'line three'], 'line four', ['─────── ↓ 1 more ───────'])
    ],
    ['a draft while Pi works', editor([WORKING], 'steer this', [RULE])],
    ['a draft under a narrow working spinner', editor([`───⠸${'─'.repeat(6)}`], 'fix it', [RULE])],
    [
      'a scrolled draft while Pi works',
      editor([`── ⠸ Working ──── ↑ 2 more ${'─'.repeat(6)}`], 'line three', [RULE])
    ]
  ])('holds mail for %s', (_label, context) => {
    expect(piComposerHoldsDraft(context)).toBe(true)
  })

  it.each([
    ['no rule below the cursor', editor([RULE], 'text', ['~/work'])],
    ['no rule above the cursor', editor(['output'], 'text', [RULE])],
    ['the cursor on a rule', editor(['text'], RULE, [RULE])],
    ['an empty editor while Pi works', editor([WORKING], '', [RULE])],
    [
      'an empty editor under an earlier chat rule',
      editor([RULE, 'tool output', WORKING], '', [RULE])
    ]
  ])('lets mail through %s', (_label, context) => {
    expect(piComposerHoldsDraft(context)).toBe(false)
  })

  it.each([
    ['pi', true],
    ['claude', false]
  ] as const)('routes a %s pane to its own draft reader: %s', async (agent, held) => {
    const context = await fixtureContext('pi-1-6-composer-draft')
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: agent,
      launchAgent: agent,
      data: ''
    })
    expect(runtime['hasComposerDraft'](TRANSCRIPT_PANE_PTY_ID, context)).toBe(held)
  })
})
