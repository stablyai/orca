import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  buildAgentPromptPasteBytes
} from '../../shared/agent-prompt-injection'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import { classifyAgentPromptComposerResidue } from './agent-prompt-composer-residue'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/composer-residue',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/composer-residue',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const FRAME = '─'.repeat(40)
const WORKING_TITLE = '\x1b]0;Codex working\x07'

/** A Claude-shaped composer: a framed `❯` line on row 4, cursor after the typed text. */
function composerFrame(typed: string, dimSuggestion = ''): string {
  const suggestion = dimSuggestion ? `\x1b[2m${dimSuggestion}\x1b[22m` : ''
  return (
    `\x1b[2J\x1b[HClaude Code\r\n\r\n${FRAME}\r\n❯ ${typed}${suggestion}\r\n${FRAME}\r\n` +
    `\x1b[4;${3 + typed.length}H`
  )
}

function composerContext(typed: string, rawAfterCursor = ''): TerminalCursorContext {
  return {
    rows: [FRAME, `❯ ${typed}${rawAfterCursor}`],
    typedRows: [FRAME, `❯ ${typed}`],
    promptGlyphBoldRows: [false, false],
    rowsBelow: [FRAME],
    typedRowsBelow: [FRAME],
    beforeCursor: `❯ ${typed}`,
    afterCursor: '',
    rawAfterCursor,
    cursorHidden: false,
    cursorViewportRow: 3
  }
}

describe('classifyAgentPromptComposerResidue', () => {
  it('reports other typed text as foreign', () => {
    expect(
      classifyAgentPromptComposerResidue(
        composerContext('/hel'),
        buildAgentPromptPasteBytes('Responda apenas: OK4')
      )
    ).toBe('foreign')
  })

  it('recognizes its own parked paste, whitespace aside', () => {
    const payload = buildAgentPromptPasteBytes('review this\nchange')
    expect(
      classifyAgentPromptComposerResidue(composerContext('review   this change'), payload, {
        payload,
        landed: false
      })
    ).toBe('same-prompt')
  })

  it('compares the typed lead line with the pasted prompt', () => {
    const payload = buildAgentPromptPasteBytes('review this', 'Orca task:')
    expect(
      classifyAgentPromptComposerResidue(composerContext('Orca task: review this'), payload, {
        payload,
        landed: false
      })
    ).toBe('same-prompt')
  })

  it('does not take matching words it did not paste for its own prompt', () => {
    const parked = buildAgentPromptPasteBytes('if ready:\ndeploy()')
    const requested = buildAgentPromptPasteBytes('if ready:\n    deploy()')
    expect(
      classifyAgentPromptComposerResidue(composerContext('if ready: deploy()'), requested)
    ).toBe('foreign')
    // Why: the screen drops indentation, so only a byte-identical earlier paste is "ours".
    expect(
      classifyAgentPromptComposerResidue(composerContext('if ready: deploy()'), requested, {
        payload: parked,
        landed: false
      })
    ).toBe('foreign')
  })

  it('reads its own landed prompt, still painted, as an empty composer', () => {
    const first = buildAgentPromptPasteBytes('first task')
    const landed = { payload: first, landed: true }
    expect(
      classifyAgentPromptComposerResidue(
        composerContext('first task'),
        buildAgentPromptPasteBytes('second task'),
        landed
      )
    ).toBe('none')
    expect(classifyAgentPromptComposerResidue(composerContext('first task'), first, landed)).toBe(
      'none'
    )
    expect(classifyAgentPromptComposerResidue(composerContext('/hel'), first, landed)).toBe(
      'foreign'
    )
  })

  it('does not count a dim cursor-right suggestion as input', () => {
    expect(
      classifyAgentPromptComposerResidue(
        composerContext('', 'proceed with the release'),
        buildAgentPromptPasteBytes('review this')
      )
    ).toBe('none')
  })

  it('does not count a dim suggestion wrapped below the cursor as input', () => {
    // The shared detector's own wrapped-suggestion fixture (terminal-composer-draft.test.ts).
    expect(
      classifyAgentPromptComposerResidue(
        {
          rows: ['────────', '❯ proceed with the release'],
          typedRows: ['────────', '❯'],
          promptGlyphBoldRows: [false, false],
          rowsBelow: ['  and close the pull request', '────────'],
          typedRowsBelow: ['', '────────'],
          beforeCursor: '❯ ',
          afterCursor: '',
          rawAfterCursor: 'proceed with the release',
          cursorHidden: false,
          cursorViewportRow: 8
        },
        buildAgentPromptPasteBytes('review this')
      )
    ).toBe('none')
  })

  it('still reads typed text in a Codex composer whose footer is dim', () => {
    expect(
      classifyAgentPromptComposerResidue(
        {
          rows: ['› review the change'],
          typedRows: ['› review the change'],
          promptGlyphBoldRows: [true],
          rowsBelow: ['', '  Release train'],
          typedRowsBelow: ['', ''],
          rowsBelowWrapped: [false, false],
          beforeCursor: '› review the change',
          afterCursor: '',
          rawAfterCursor: '',
          cursorHidden: false,
          cursorViewportRow: 4
        },
        buildAgentPromptPasteBytes('another task')
      )
    ).toBe('foreign')
  })

  it('treats an empty or unrecognized composer as nothing to protect', () => {
    const payload = buildAgentPromptPasteBytes('review this')
    expect(classifyAgentPromptComposerResidue(composerContext(''), payload)).toBe('none')
    expect(classifyAgentPromptComposerResidue(null, payload)).toBe('none')
    expect(
      classifyAgentPromptComposerResidue(
        { ...composerContext('/hel'), rows: ['plain output', '❯ /hel'] },
        payload
      )
    ).toBe('none')
  })
})

describe('agent prompt composer residue (#15976)', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses to paste onto text already in the composer', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', composerFrame('/hel'), Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, 'Responda apenas: OK4', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_composer_not_empty')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes).toEqual([])
  })

  it('submits its own parked prompt with Enter alone instead of pasting it twice', async () => {
    vi.useFakeTimers()
    let enters = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', composerFrame('review this change'), Date.now())
        } else if (data === '\r' && ++enters > 1) {
          // The first Enter is lost, so the prompt stays parked; the retry's Enter lands.
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    const first = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    const stalled = expect(first).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()
    await stalled
    const retry = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(retry).resolves.toMatchObject({ accepted: true, bytesWritten: 1 })
    expect(writes.slice(2)).toEqual(['\r'])
  })

  it('sends only Enter for a parked prompt when the agent joins submit to the paste', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          // The Enter that rode in the paste write is lost.
          runtime.onPtyData('pty-prompt', composerFrame('review this change'), Date.now())
        } else if (data === '\r') {
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      },
      'omp'
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    const first = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    const stalled = expect(first).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()
    await stalled
    const retry = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(retry).resolves.toMatchObject({ accepted: true, bytesWritten: 1 })
    expect(writes.slice(1)).toEqual(['\r'])
  })

  it.each([
    ['leaves the parked prompt alone', ''],
    ['replaces the parked prompt', 'something else entirely']
  ])(
    'judges a parked prompt again after a pre-write check that %s',
    async (_label, replacement) => {
      vi.useFakeTimers()
      let enters = 0
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            runtime.onPtyData('pty-prompt', composerFrame('review this change'), Date.now())
          } else if (data === '\r' && ++enters > 1) {
            runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      const stalled = expect(first).rejects.toThrow('agent_prompt_stalled')
      await vi.runAllTimersAsync()
      await stalled
      const retry = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving',
        beforeWrite: async () => {
          // Another writer to the pane changes the composer while the pre-write check awaits.
          if (replacement) {
            runtime.onPtyData('pty-prompt', composerFrame(replacement), Date.now())
          }
          await Promise.resolve()
        }
      })
      const settled = Promise.allSettled([retry])
      await vi.runAllTimersAsync()
      const [result] = await settled

      if (replacement) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({ message: 'agent_prompt_composer_not_empty' })
        })
        expect(writes.slice(2)).toEqual([])
      } else {
        expect(result).toMatchObject({
          status: 'fulfilled',
          value: { accepted: true, bytesWritten: 1 }
        })
        expect(writes.slice(2)).toEqual(['\r'])
      }
    }
  )

  it('submits a parked prompt when only a title arrives during the pre-write check', async () => {
    vi.useFakeTimers()
    let enters = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', composerFrame('review this change'), Date.now())
        } else if (data === '\r' && ++enters > 1) {
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    const first = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    const stalled = expect(first).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()
    await stalled
    const retry = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving',
      beforeWrite: async () => {
        // A title leaves the composer as it was; only the write chain shows the output.
        runtime.onPtyData('pty-prompt', '\x1b]0;Claude Code\x07', Date.now())
        await Promise.resolve()
      }
    })
    const settled = Promise.allSettled([retry])
    await vi.runAllTimersAsync()
    const [result] = await settled

    // Why: harmless output leaves the parked prompt in place, so the retry's Enter still belongs to it.
    expect({ result, writes: writes.slice(2) }).toMatchObject({
      result: { status: 'fulfilled', value: { accepted: true, bytesWritten: 1 } },
      writes: ['\r']
    })
  })

  it('refuses text it did not paste even when the pre-write check swaps it', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame('review this change'), Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving',
      beforeWrite: async () => {
        runtime.onPtyData('pty-prompt', composerFrame('something else entirely'), Date.now())
        await Promise.resolve()
      }
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_composer_not_empty')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes).toEqual([])
  })

  it('refuses a parked earlier paste that differs from this prompt only in whitespace', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          // The composer shows continuation rows indented its own way, not the prompt's.
          runtime.onPtyData(
            'pty-prompt',
            `\x1b[2J\x1b[HClaude Code\r\n\r\n${FRAME}\r\n❯ if ready:\r\n  deploy()\r\n${FRAME}\r\n` +
              '\x1b[5;11H',
            Date.now()
          )
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    const first = runtime.sendTerminalAgentPrompt(handle, 'if ready:\ndeploy()', {
      inputKind: 'driving'
    })
    const stalled = expect(first).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()
    await stalled
    const writesBefore = writes.length
    const indented = runtime.sendTerminalAgentPrompt(handle, 'if ready:\n    deploy()', {
      inputKind: 'driving'
    })
    const rejected = expect(indented).rejects.toThrow('agent_prompt_composer_not_empty')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.slice(writesBefore)).toEqual([])
  })

  it('pastes as before while the screen model is still hydrating', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame('/hel'), Date.now())
    runtime['headlessHydrationState'].set('pty-prompt', 'pending')

    const submission = runtime.sendTerminalAgentPrompt(handle, 'Responda apenas: OK4', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data.includes('Responda apenas: OK4'))).toHaveLength(1)
  })

  it('pastes over a dim suggestion in an otherwise empty composer', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame('', 'proceed with the release'), Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toHaveLength(1)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('lets a just-submitted prompt clear before judging the next one', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes('first task')) {
          runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
        } else if (data === '\r') {
          runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
          // The agent repaints its emptied composer a moment after taking the Enter.
          setTimeout(() => runtime.onPtyData('pty-prompt', composerFrame(''), Date.now()), 800)
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    // Why concurrent: submissions to one pane are serialized, so the second is judged right
    // after the first Enter, while the screen still shows the first prompt.
    const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
    const second = runtime.sendTerminalAgentPrompt(handle, 'second task', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(first).resolves.toMatchObject({ accepted: true })
    await expect(second).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data.includes('second task'))).toHaveLength(1)
  })

  it('pastes over a dim suggestion that wraps below the cursor', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
        }
      }
    )
    runtime.onPtyData(
      'pty-prompt',
      `\x1b[2J\x1b[HClaude Code\r\n\r\n${FRAME}\r\n❯ \x1b[2mproceed with the release\x1b[22m\r\n` +
        `\x1b[2m  and close the pull request\x1b[22m\r\n${FRAME}\r\n\x1b[4;3H`,
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toHaveLength(1)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it.each([
    ['a different', 'second task'],
    ['an identical', 'first task']
  ])(
    'pastes %s next prompt when the agent repaints its emptied composer late',
    async (_label, nextPrompt) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          const pasted = ['first task', 'second task'].find((text) => data.includes(text))
          if (pasted) {
            runtime.onPtyData('pty-prompt', composerFrame(pasted), Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // The turn starts at once, but the emptied composer is painted only later.
            setTimeout(() => runtime.onPtyData('pty-prompt', composerFrame(''), Date.now()), 1_500)
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
      const next = runtime.sendTerminalAgentPrompt(handle, nextPrompt, { inputKind: 'driving' })
      await vi.runAllTimersAsync()

      await expect(first).resolves.toMatchObject({ accepted: true })
      await expect(next).resolves.toMatchObject({ accepted: true })
      expect(writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toHaveLength(
        2
      )
      expect(writes.filter((data) => data === '\r')).toHaveLength(2)
    }
  )

  it('still reads its landed prompt as a late repaint while only unrelated output arrives', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes('first task')) {
          runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
        } else if (data === '\r') {
          runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
          // Output that leaves the stale composer paint as it was.
          setTimeout(() => runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now()), 300)
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
    const next = runtime.sendTerminalAgentPrompt(handle, 'second task', { inputKind: 'driving' })
    await vi.runAllTimersAsync()

    await expect(first).resolves.toMatchObject({ accepted: true })
    await expect(next).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data.includes('second task'))).toHaveLength(1)
  })

  it.each([
    ['a different', 'second task'],
    ['an identical', 'first task']
  ])(
    'refuses %s next prompt onto its landed prompt recalled after the composer emptied',
    async (_label, nextPrompt) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes('first task')) {
            runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // The agent empties its composer as the turn starts.
            runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const startedAt = Date.now()
      const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(first).resolves.toMatchObject({ accepted: true })
      // Someone recalls the prompt into the emptied composer, still inside the late-repaint window.
      runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
      const writesBefore = writes.length
      const next = runtime.sendTerminalAgentPrompt(handle, nextPrompt, { inputKind: 'driving' })
      const settled = Promise.allSettled([next])
      await vi.advanceTimersByTimeAsync(2_000)
      const [result] = await settled

      expect(Date.now() - startedAt).toBeLessThan(10_000)
      expect({ result, writes: writes.slice(writesBefore) }).toMatchObject({
        result: {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'agent_prompt_composer_not_empty' })
        },
        writes: []
      })
    }
  )

  it.each([
    ['a different', 'second task'],
    ['an identical', 'first task']
  ])(
    'refuses %s next prompt onto a recall after a composer that emptied after the turn start',
    async (_label, nextPrompt) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes('first task')) {
            runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // Only a read after a later output chunk can see this emptying.
            setTimeout(() => runtime.onPtyData('pty-prompt', composerFrame(''), Date.now()), 1_500)
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(first).resolves.toMatchObject({ accepted: true })
      runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
      const writesBefore = writes.length
      const next = runtime.sendTerminalAgentPrompt(handle, nextPrompt, { inputKind: 'driving' })
      const settled = Promise.allSettled([next])
      await vi.advanceTimersByTimeAsync(2_000)
      const [result] = await settled

      expect({ result, writes: writes.slice(writesBefore) }).toMatchObject({
        result: {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'agent_prompt_composer_not_empty' })
        },
        writes: []
      })
    }
  )

  it.each([
    ['a hidden-cursor frame split across chunks', '\x1b[?25l', '\x1b[?25h'],
    ['a cursor-up status redraw split across chunks', '\x1b7\x1b[1;1H', '✻ Working\x1b8'],
    [
      'a status line redrawn below the composer split across chunks',
      '\x1b7\x1b[6;1H',
      '✻ Working\x1b8'
    ]
  ])(
    'still pastes a different next prompt over a late repaint after %s',
    async (_label, chunkOne, chunkTwo) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          const pasted = ['first task', 'second task'].find((text) => data.includes(text))
          if (pasted) {
            runtime.onPtyData('pty-prompt', composerFrame(pasted), Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // A read between these two chunks cannot see the composer, which still shows the paste.
            setTimeout(() => runtime.onPtyData('pty-prompt', chunkOne, Date.now()), 300)
            setTimeout(() => runtime.onPtyData('pty-prompt', chunkTwo, Date.now()), 320)
            setTimeout(() => runtime.onPtyData('pty-prompt', composerFrame(''), Date.now()), 1_500)
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
      const next = runtime.sendTerminalAgentPrompt(handle, 'second task', { inputKind: 'driving' })
      const settled = Promise.allSettled([first, next])
      await vi.runAllTimersAsync()
      const [firstResult, nextResult] = await settled

      expect({
        firstResult: firstResult.status,
        nextReason: nextResult.status === 'rejected' ? String(nextResult.reason?.message) : null,
        pastes: writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)).length
      }).toEqual({ firstResult: 'fulfilled', nextReason: null, pastes: 2 })
    }
  )

  it.each([
    ['a different', 'second task'],
    ['an identical', 'first task']
  ])(
    'refuses %s next prompt onto a recall after the composer emptied to a dim ghost of the same words',
    async (_label, nextPrompt) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes('first task')) {
            runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // Emptied, but showing the sent words as a dim suggestion: no typed text is left.
            setTimeout(
              () => runtime.onPtyData('pty-prompt', composerFrame('', 'first task'), Date.now()),
              1_500
            )
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(first).resolves.toMatchObject({ accepted: true })
      runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
      const writesBefore = writes.length
      const next = runtime.sendTerminalAgentPrompt(handle, nextPrompt, { inputKind: 'driving' })
      const settled = Promise.allSettled([next])
      await vi.advanceTimersByTimeAsync(2_000)
      const [result] = await settled

      expect({ result, writes: writes.slice(writesBefore) }).toMatchObject({
        result: {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'agent_prompt_composer_not_empty' })
        },
        writes: []
      })
    }
  )

  it('still pastes a different next prompt over a late repaint that shows a dim completion after the landed text', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        const pasted = ['first task', 'second task'].find((text) => data.includes(text))
        if (pasted) {
          runtime.onPtyData('pty-prompt', composerFrame(pasted), Date.now())
        } else if (data === '\r') {
          runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
          // The stale paste is still painted, now with a dim completion that is not input.
          setTimeout(
            () => runtime.onPtyData('pty-prompt', composerFrame('first task', ' now'), Date.now()),
            300
          )
          setTimeout(() => runtime.onPtyData('pty-prompt', composerFrame(''), Date.now()), 1_500)
        }
      }
    )
    runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

    const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
    const next = runtime.sendTerminalAgentPrompt(handle, 'second task', { inputKind: 'driving' })
    const settled = Promise.allSettled([first, next])
    await vi.runAllTimersAsync()
    const [firstResult, nextResult] = await settled

    expect({
      firstResult: firstResult.status,
      nextReason: nextResult.status === 'rejected' ? String(nextResult.reason?.message) : null,
      pastes: writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)).length
    }).toEqual({ firstResult: 'fulfilled', nextReason: null, pastes: 2 })
  })

  it.each([
    [
      'a multi-line',
      'if ready:\ndeploy()',
      `\x1b[2J\x1b[HClaude Code\r\n\r\n${FRAME}\r\n❯ if ready:\r\n  deploy()\r\n${FRAME}\r\n` +
        '\x1b[5;11H'
    ],
    ['a double-spaced', 'first  task', composerFrame('first  task')]
  ])(
    'still pastes a different next prompt over a late repaint of %s landed prompt',
    async (_label, firstPrompt, firstFrame) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes('second task')) {
            runtime.onPtyData('pty-prompt', composerFrame('second task'), Date.now())
          } else if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            // The composer still shows the landed prompt, re-wrapped or with its own spacing.
            runtime.onPtyData('pty-prompt', firstFrame, Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // The turn starts at once, but the emptied composer is painted only later.
            setTimeout(() => runtime.onPtyData('pty-prompt', composerFrame(''), Date.now()), 1_500)
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, firstPrompt, { inputKind: 'driving' })
      const next = runtime.sendTerminalAgentPrompt(handle, 'second task', { inputKind: 'driving' })
      const settled = Promise.allSettled([first, next])
      await vi.runAllTimersAsync()
      const [firstResult, nextResult] = await settled

      expect({
        firstResult: firstResult.status,
        nextReason: nextResult.status === 'rejected' ? String(nextResult.reason?.message) : null,
        pastes: writes.filter((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)).length
      }).toEqual({ firstResult: 'fulfilled', nextReason: null, pastes: 2 })
    }
  )

  it.each([
    ['a different', 'second task'],
    ['an identical', 'first task']
  ])(
    'refuses %s next prompt onto a recall after the composer showed other words',
    async (_label, nextPrompt) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes('first task')) {
            runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
          } else if (data === '\r') {
            runtime.onPtyData('pty-prompt', `\x1b]0;Codex idle\x07${WORKING_TITLE}`, Date.now())
            // The composer goes from the landed paste straight to other words, never read empty.
            setTimeout(
              () => runtime.onPtyData('pty-prompt', composerFrame('fix the'), Date.now()),
              1_500
            )
          }
        }
      )
      runtime.onPtyData('pty-prompt', composerFrame(''), Date.now())

      const first = runtime.sendTerminalAgentPrompt(handle, 'first task', { inputKind: 'driving' })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(first).resolves.toMatchObject({ accepted: true })
      // A history recall replaces those words with the landed prompt.
      runtime.onPtyData('pty-prompt', composerFrame('first task'), Date.now())
      const writesBefore = writes.length
      const next = runtime.sendTerminalAgentPrompt(handle, nextPrompt, { inputKind: 'driving' })
      const settled = Promise.allSettled([next])
      await vi.advanceTimersByTimeAsync(2_000)
      const [result] = await settled

      expect({ result, writes: writes.slice(writesBefore) }).toMatchObject({
        result: {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'agent_prompt_composer_not_empty' })
        },
        writes: []
      })
    }
  )
})
