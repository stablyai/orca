import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import {
  projectTerminalTailLines,
  projectTerminalVisibleLines
} from './orca-runtime-terminal-projection'
import { buildVisibleSnapshotReadFallback } from './terminal-tail-read'
import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'

const CLAUDE_FRAME = 'Build passed\r\n────────────────────────\r\n❯ '
const CLAUDE_END = '\r\n────────────────────────\x1b8'

describe('rendered composer draft origin', () => {
  it.each([
    {
      name: 'Claude next-prompt suggestion',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[2mapprove the Nu .jsonl.zst path swap\x1b[0m${CLAUDE_END}`,
      draft: 'approve the Nu .jsonl.zst path swap',
      origin: 'agent_suggestion'
    },
    {
      name: 'Claude fresh-session placeholder',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[2mTry "fix lint errors"\x1b[0m${CLAUDE_END}`,
      draft: undefined,
      origin: 'agent_suggestion'
    },
    {
      name: 'wrapped Claude suggestion',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[2m${'release '.repeat(14)}now\x1b[0m${CLAUDE_END}`,
      draft: `${'release '.repeat(14)}now`,
      origin: 'agent_suggestion'
    },
    {
      name: 'real typed Claude draft',
      frame: `${CLAUDE_FRAME}approve the Nu .jsonl.zst path swap\x1b7${CLAUDE_END}`,
      draft: 'approve the Nu .jsonl.zst path swap',
      origin: 'user_input'
    },
    {
      name: 'typed draft starting with the suggestion text',
      frame: `${CLAUDE_FRAME}approve the Nu .jsonl.zst path swap after review\x1b7${CLAUDE_END}`,
      draft: 'approve the Nu .jsonl.zst path swap after review',
      origin: 'user_input'
    },
    {
      name: 'typed Try placeholder wording with cursor restored to the start',
      frame: `${CLAUDE_FRAME}\x1b7Try "fix lint errors"${CLAUDE_END}`,
      draft: 'Try "fix lint errors"',
      origin: 'user_input'
    },
    {
      name: 'typed stock Codex wording with cursor restored to the start',
      frame: '\x1b[1m›\x1b[0m \x1b7Explain this codebase\r\n\r\ngpt-5.6 · ~/repo\x1b8',
      draft: 'Explain this codebase',
      origin: 'user_input'
    },
    {
      name: 'grey foreground without dim styling',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[90mrelease now\x1b[0m${CLAUDE_END}`,
      draft: 'release now',
      origin: 'user_input'
    },
    {
      name: 'mixed dim and normal suffix cells',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[2mrelease\x1b[0m now${CLAUDE_END}`,
      draft: 'now',
      origin: 'unknown'
    },
    {
      name: 'typed prefix beside a dim suggestion',
      frame: `${CLAUDE_FRAME}release\x1b7\x1b[2m now\x1b[0m${CLAUDE_END}`,
      draft: 'release now',
      origin: 'unknown'
    },
    {
      name: 'dim suffix with typed continuation below',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[2mrelease\x1b[0m\r\n  after review${CLAUDE_END}`,
      draft: 'release\nafter review',
      origin: 'unknown'
    },
    {
      name: 'draft reconstructed above the cursor',
      frame: `${CLAUDE_FRAME}release\r\n  after review\x1b7${CLAUDE_END}`,
      draft: 'release\nafter review',
      origin: 'unknown'
    },
    {
      name: 'normal text after cursor moved into a typed draft',
      frame: `${CLAUDE_FRAME}release\x1b7 now${CLAUDE_END}`,
      draft: 'release now',
      origin: 'user_input'
    },
    {
      name: 'dim input left of the cursor',
      frame: `${CLAUDE_FRAME}\x1b[2mrelease\x1b[0m\x1b7${CLAUDE_END}`,
      draft: 'release',
      origin: 'unknown'
    },
    {
      name: 'empty composer',
      frame: `${CLAUDE_FRAME}\x1b7${CLAUDE_END}`,
      draft: undefined,
      origin: undefined
    },
    {
      name: 'hidden cursor',
      frame: `${CLAUDE_FRAME}\x1b7\x1b[2mrelease\x1b[0m${CLAUDE_END}\x1b[?25l`,
      draft: undefined,
      origin: undefined
    }
  ])('$name', async ({ frame, draft, origin }) => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    try {
      await emulator.write(frame)
      for (const projection of [
        projectTerminalVisibleLines(emulator),
        projectTerminalTailLines(emulator, 24)
      ]) {
        const read = buildVisibleSnapshotReadFallback(
          { handle: 'term_test', status: 'running', tail: [], truncated: false, nextCursor: null },
          projection.lines,
          undefined,
          projection.draft,
          projection.tailRows,
          projection.draftOrigin
        )
        expect(read.draft).toBe(draft)
        expect(read.draftOrigin).toBe(origin)
        if (draft) {
          expect(read.tail.some((line) => line === '❯' || line === '›')).toBe(true)
          expect(read.tail.join('\n')).not.toContain(draft)
        }
      }
    } finally {
      emulator.dispose()
    }
  })

  it.each([
    { fixture: 'codex-0-137-0-rotating-placeholder', cols: 80, rows: 24 },
    { fixture: 'codex-0157-plain-ready', cols: 120, rows: 40 }
  ])('classifies the captured $fixture placeholder', async ({ fixture, cols, rows }) => {
    const emulator = new HeadlessEmulator({ cols, rows })
    try {
      await emulator.write(readRuntimeFixture(fixture))
      const projection = projectTerminalVisibleLines(emulator)
      expect(projection.draft).toBeUndefined()
      expect(projection.draftOrigin).toBe('agent_suggestion')
    } finally {
      emulator.dispose()
    }
  })

  it('replaces prior provenance when a newer snapshot has no evidence', () => {
    const prior: RuntimeTerminalRead = {
      handle: 'term_test',
      status: 'running',
      tail: ['❯'],
      truncated: false,
      nextCursor: null,
      draft: 'suggested text',
      draftOrigin: 'agent_suggestion'
    }
    const empty = buildVisibleSnapshotReadFallback(prior, ['❯'], undefined)
    expect(empty.draft).toBeUndefined()
    expect(empty.draftOrigin).toBeUndefined()
    const unclassified = buildVisibleSnapshotReadFallback(prior, ['❯'], undefined, 'typed text')
    expect(unclassified.draft).toBe('typed text')
    expect(unclassified.draftOrigin).toBe('unknown')
  })
})
