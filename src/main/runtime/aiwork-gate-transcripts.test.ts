import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/emulation/headless-emulator'
import { aiworkComposerHoldsDraft } from '../../shared/terminal/input/aiwork-composer'
import { readRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'
import { readScreenInputVeto } from './terminal/wait/screen-input-veto'
import { detectTerminalWaitBlockedReason } from './terminal/wait/terminal-wait-detection'

// Recorded from aiwork 1.26455 with Orca's OSC 7501 probe answered; see each fixture's meta.json.
type Gate = {
  name: string
  cols: number
  rows: number
  /** Literal footer text that marks the box as painted on the grid. */
  footer: string
  reason: 'agent-approval-prompt' | 'agent-interactive-prompt'
}

const GATES: Gate[] = [
  {
    name: 'aiwork-approval-en-120x40',
    cols: 120,
    rows: 40,
    footer: 'enter confirm current option',
    reason: 'agent-approval-prompt'
  },
  {
    name: 'aiwork-approval-zh-120x40',
    cols: 120,
    rows: 40,
    footer: 'enter 确认当前选项',
    reason: 'agent-approval-prompt'
  },
  {
    name: 'aiwork-approval-zh-hk-120x40',
    cols: 120,
    rows: 40,
    footer: 'enter 確認當前選項',
    reason: 'agent-approval-prompt'
  },
  {
    name: 'aiwork-approval-zh-60x30',
    cols: 60,
    rows: 30,
    footer: 'enter 确认当前选项',
    reason: 'agent-approval-prompt'
  },
  {
    name: 'aiwork-question-en-120x40',
    cols: 120,
    rows: 40,
    footer: 'enter Submit',
    reason: 'agent-interactive-prompt'
  },
  {
    name: 'aiwork-question-zh-120x40',
    cols: 120,
    rows: 40,
    footer: 'enter 提交',
    reason: 'agent-interactive-prompt'
  }
]

function vetoes(lines: string[]): boolean {
  return readScreenInputVeto('aiwork', () => ({ lines, alternateScreen: false })) === true
}

function lastProgramState(data: string): string | null {
  // oxlint-disable-next-line no-control-regex -- OSC 7501 reports start with ESC.
  const states = [...data.matchAll(/\x1b\]7501;state=([a-z]+)/g)]
  return states.at(-1)?.[1] ?? null
}

describe('AiWork recorded gates', () => {
  it.each(GATES)(
    'blocks and vetoes input while $name shows its box, and clears once the turn ends',
    async ({ name, cols, rows, footer, reason }) => {
      const data = readRuntimeFixture(name)
      let sawBox = false
      let consumed = 0
      let idleAfterBox: { blocked: string | null; veto: boolean } | null = null
      for await (const frame of replayTranscript(data, cols, rows)) {
        consumed += 64
        const veto = vetoes(frame.ruledScreenLines)
        const blocked = detectTerminalWaitBlockedReason(frame.waitText)
        // Ground truth is AiWork's own OSC 7501 report: blocked until the answer is taken.
        const open =
          lastProgramState(data.slice(0, consumed)) === 'blocked' &&
          frame.ruledScreenLines.some((line) => line.includes(footer))
        if (open) {
          sawBox = true
          expect({ veto, blocked }).toEqual({ veto: true, blocked: reason })
        }
        // AiWork reports idle over OSC 7501 when the turn has finished and the composer is back.
        if (sawBox && !idleAfterBox && lastProgramState(data.slice(0, consumed)) === 'idle') {
          idleAfterBox = { blocked, veto }
        }
      }
      expect(sawBox).toBe(true)
      expect(idleAfterBox).toEqual({ blocked: null, veto: false })
    }
  )

  it.each([
    ['aiwork-plan-zh-120x40', '废弃(r)'],
    ['aiwork-plan-en-120x40', 'Discard(r)']
  ])('vetoes input for the whole time %s shows its plan review', async (name, footer) => {
    let reviewFrames = 0
    let blockedFrames = 0
    let last: { blocked: string | null; veto: boolean } = { blocked: 'unread', veto: true }
    for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
      last = {
        blocked: detectTerminalWaitBlockedReason(frame.waitText),
        veto: vetoes(frame.ruledScreenLines)
      }
      // AiWork reports idle while its plan review is open, so only the grid can refuse input.
      if (frame.ruledScreenLines.some((line) => line.includes(footer))) {
        reviewFrames += 1
        expect(vetoes(frame.ruledScreenLines)).toBe(true)
        if (detectTerminalWaitBlockedReason(frame.waitText) === 'agent-interactive-prompt') {
          blockedFrames += 1
        }
      }
    }
    // The text anchor needs the whole footer, which the panel paints over its first few frames.
    expect(reviewFrames).toBeGreaterThan(0)
    expect(blockedFrames).toBeGreaterThan(reviewFrames * 0.9)
    // The recording ends after the approved plan has run and the composer is back.
    expect(last).toEqual({ blocked: null, veto: false })
  })

  it.each(['aiwork-ready-en-120x40', 'aiwork-ready-zh-120x40', 'aiwork-draft-en-120x40'])(
    'neither blocks nor vetoes %s, which never shows a gate',
    async (name) => {
      for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
        expect(detectTerminalWaitBlockedReason(frame.waitText)).toBeNull()
        expect(vetoes(frame.ruledScreenLines)).toBe(false)
      }
    }
  )
})

describe('AiWork composer draft', () => {
  /** The cursor context at each point where AiWork shows its composer with the caret in it. */
  async function composerReads(name: string): Promise<boolean[]> {
    const data = readRuntimeFixture(name)
    const emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
    const reads: boolean[] = []
    try {
      for (let index = 0; index < data.length; index += 256) {
        await emulator.write(data.slice(index, index + 256))
        const context = emulator.getCursorLineContext()
        if (context && !context.cursorHidden && /^\s*❱/u.test(context.beforeCursor)) {
          reads.push(aiworkComposerHoldsDraft(context))
        }
      }
      return reads
    } finally {
      emulator.dispose()
    }
  }

  it.each(['aiwork-ready-en-120x40', 'aiwork-ready-zh-120x40'])(
    'does not hold mail for the placeholder in %s',
    async (name) => {
      const reads = await composerReads(name)
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((holds) => !holds)).toBe(true)
    }
  )

  it('holds mail once the user has typed a draft', async () => {
    expect(await composerReads('aiwork-draft-en-120x40')).toEqual([false, true])
  })
})
