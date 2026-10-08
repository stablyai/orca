import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import {
  finalReplayFrame,
  readRuntimeFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import {
  describeScreenRuledAgentTranscripts,
  readsIdleComposer
} from './screen-ruled-agent-transcript-suite'
import {
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isQuietReadyScreenBody
} from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// agy 1.2.14 on macOS, AGY_CLI_HIDE_ACCOUNT_INFO=1 (see each .meta.json); STA-8741.
const at120x40 = (name: string, what: string) => ({ name, what, cols: 120, rows: 40 })
const READY = [
  at120x40('antigravity-1-2-14-ready', 'settled startup'),
  at120x40('antigravity-1-2-14-ready-accept-edits', '--mode accept-edits'),
  at120x40('antigravity-1-2-14-ready-plan', '--mode plan'),
  { name: 'antigravity-1-2-14-ready-80x24', what: 'settled startup', cols: 80, rows: 24 },
  at120x40('antigravity-1-2-14-picker-dismissed', '/model closed with Esc'),
  at120x40('antigravity-1-2-14-turn-ended', 'a turn has ended')
]
const NOT_READY = [
  at120x40('antigravity-1-2-14-model-picker', '/model picker open'),
  at120x40('antigravity-1-2-14-command-palette', 'slash palette open'),
  at120x40('antigravity-1-2-14-busy-thinking', 'spinner before the answer'),
  at120x40('antigravity-1-2-14-busy-streaming', 'answer streaming'),
  at120x40('antigravity-1-2-14-trust-dialog', 'workspace trust dialog'),
  at120x40('antigravity-1-2-14-draft', 'unsent text in the composer')
]

describe('Antigravity 1.2.14 readiness from captured bytes', () => {
  describeScreenRuledAgentTranscripts({
    agent: 'antigravity',
    foregroundProcess: 'agy',
    ready: READY,
    notReady: NOT_READY,
    // Why these: the line-folded text rule reads only these ready screens.
    readyWithoutScreen: [
      'antigravity-1-2-14-ready',
      'antigravity-1-2-14-ready-80x24',
      'antigravity-1-2-14-picker-dismissed'
    ]
  })

  it.each([
    'antigravity-1-2-14-ready-accept-edits',
    'antigravity-1-2-14-ready-plan',
    'antigravity-1-2-14-turn-ended'
  ])('%s: the line-folded text rule alone misses this ready screen', async (name) => {
    const { waitText } = await finalReplayFrame(name, 120, 40)
    expect(isKnownReadyPromptPreview(waitText)).toBe(false)
  })

  it('does not let the text rules overrule a screen that refused', async () => {
    const { waitText } = await finalReplayFrame('antigravity-1-2-14-picker-dismissed', 120, 40)
    const { ruledScreenLines } = await finalReplayFrame('antigravity-1-2-14-model-picker', 120, 40)
    // Presence precondition: the text alone would say ready.
    expect(isKnownReadyPromptPreview(waitText)).toBe(true)
    expect(isQuietReadyScreenBody(waitText, 'antigravity', () => ruledScreenLines)).toBe(false)
    expect(isKnownReadyPromptBody(waitText, 'antigravity', () => ruledScreenLines, false)).toBe(
      false
    )
  })

  // Why a caret rule is not enough: agy keeps the bare composer caret painted through both.
  it.each(['antigravity-1-2-14-busy-streaming', 'antigravity-1-2-14-model-picker'])(
    '%s: the bare caret is still on screen',
    async (name) => {
      const { ruledScreenLines } = await finalReplayFrame(name, 120, 40)
      expect(ruledScreenLines.some((line) => line.trim() === '>')).toBe(true)
    }
  )

  // Why a clocked pane waits for quiet: the submit repaint clears the composer a moment before
  // it swaps `? for shortcuts` for `esc to cancel`.
  it('reads a submit repaint as ready for a moment mid-turn', async () => {
    const data = readRuntimeFixture('antigravity-1-2-14-turn-ended')
    let submitted = false
    let answered = false
    let readyMidTurn = 0
    for await (const { ruledScreenLines } of replayTranscript(data, 120, 40)) {
      submitted ||= ruledScreenLines.some((line) => line.startsWith('> Without using any tools'))
      answered ||= ruledScreenLines.some((line) => line.trim() === 'ok')
      if (submitted && !answered && readsIdleComposer('antigravity', ruledScreenLines)) {
        readyMidTurn += 1
      }
    }
    expect(submitted && answered).toBe(true)
    expect(readyMidTurn).toBeGreaterThan(0)
  })

  // Why: a shell auto-title names the process; before the screen decided, that name-only idle
  // title settled a pane whose picker carries no blocked wording.
  it('does not settle an open model picker from a name-only `agy` title', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      launchAgent: 'antigravity',
      data: `${String.fromCharCode(27)}]0;agy${String.fromCharCode(7)}${readRuntimeFixture('antigravity-1-2-14-model-picker')}`,
      size: { cols: 120, rows: 40 }
    })
    await runtime.readTerminal(handle, { screen: true })
    await expect(waitForTranscriptIdle({ runtime, handle }, 5_000)).rejects.toThrow(/timeout/)
  }, 15_000)

  // Why this recording: only the screen reads it ready, so settling proves the grid is trusted.
  it('trusts a reflowed grid again once a PTY resize off it repaints the TUI', async () => {
    const turnEnded = readRuntimeFixture('antigravity-1-2-14-turn-ended')
    const options = {
      paneTitle: 'Terminal',
      foregroundProcess: 'agy',
      launchAgent: 'antigravity' as const,
      data: turnEnded,
      size: { cols: 100, rows: 30 }
    }
    const { runtime, handle } = await createTranscriptPane(options)
    const resizePty = (cols: number, rows: number) => {
      options.size = { cols, rows }
      runtime.onExternalPtyResize(TRANSCRIPT_PANE_PTY_ID, cols, rows)
    }
    const settles = async () =>
      (await waitForTranscriptIdle({ runtime, handle }, 5_000).catch(() => ({ satisfied: false })))
        .satisfied
    options.size = { cols: 120, rows: 40 }
    runtime.reflowHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, 120, 40)
    await runtime.readTerminal(handle, { screen: true })
    expect(await settles()).toBe(false)
    resizePty(121, 40)
    resizePty(120, 40)
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, turnEnded, Date.now())
    await runtime.readTerminal(handle, { screen: true })
    expect(await settles()).toBe(true)
  }, 45_000)
})
