import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  replayTranscript,
  type TranscriptReplayFrame
} from './agent-transcript-replay-test-harness'
import {
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isKnownReadyPromptSettled
} from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// codex-cli 0.157.1 recordings at 120x40 (see each .meta.json); STA-8628.
const PLAIN = 'codex-0157-plain-ready'
const EFFORT_OVERRIDE = 'codex-0157-effort-override-embedded-warning'
const CONFIG_OVERRIDE = 'codex-0157-config-override-embedded-warning'
const NO_DAEMON = 'codex-0157-no-daemon-effort-override'
// Fresh CODEX_HOME: the provisional header stays up while Codex installs and starts its daemon.
const FRESH_HOME = 'codex-0157-fresh-home-daemon-install'
const ALL_FIXTURES = [PLAIN, EFFORT_OVERRIDE, CONFIG_OVERRIDE, NO_DAEMON, FRESH_HOME]

async function finalFrame(
  name: string,
  cols: number,
  rows: number
): Promise<TranscriptReplayFrame> {
  let last: TranscriptReplayFrame | null = null
  for await (const frame of replayTranscript(readRuntimeFixture(name), cols, rows)) {
    last = frame
  }
  if (!last) {
    throw new Error(`empty fixture ${name}`)
  }
  return last
}

function screenShowsLoadingHeader(screenLines: string[]): boolean {
  const screen = screenLines.join('\n').toLowerCase()
  return screen.includes('openai codex') && /(?:model|directory):\s+loading/.test(screen)
}

// Codex's default status row opens with `<model> <effort> ·`; only the live chat paints it.
const LIVE_STATUS_ROW_RE = /\b(?:default|minimal|low|medium|high|xhigh) ·/

function screenShowsProvisionalStartup(screenLines: string[]): boolean {
  return (
    screenShowsLoadingHeader(screenLines) &&
    !screenLines.some((line) => LIVE_STATUS_ROW_RE.test(line.toLowerCase()))
  )
}

describe('Codex 0.157 header readiness from captured bytes', () => {
  it.each([EFFORT_OVERRIDE, CONFIG_OVERRIDE])(
    '%s: the line-folded wait text never shows a ready header',
    async (name) => {
      const { waitText } = await finalFrame(name, 120, 40)
      // Why: the cell-diff repaint folds to `dirctory:` — the STA-8628 timeout.
      expect(waitText.toLowerCase()).toContain('dirctory:')
      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    }
  )

  it.each(ALL_FIXTURES)(
    '%s: the screen never adds readiness while loading, and is ready at the final screen',
    async (name) => {
      let sawLoadingHeader = false
      let last: TranscriptReplayFrame | null = null
      for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
        if (screenShowsLoadingHeader(frame.screenLines)) {
          sawLoadingHeader = true
          expect(isKnownReadyPromptBody('', 'codex', () => frame.screenLines)).toBe(false)
        }
        last = frame
      }
      // Presence precondition: a loading frame was actually exercised.
      expect(sawLoadingHeader).toBe(true)
      expect(last).not.toBeNull()
      expect(isKnownReadyPromptBody(last!.waitText, 'codex', () => last!.screenLines)).toBe(true)
    }
  )

  // Why: 0.157 discards input typed during its daemon start, behind the provisional header.
  it.each(ALL_FIXTURES)(
    '%s: never ready while the screen shows the provisional `model: loading` startup screen',
    async (name) => {
      let sawTextOnlyReadiness = false
      for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
        if (screenShowsProvisionalStartup(frame.screenLines)) {
          sawTextOnlyReadiness ||= isKnownReadyPromptPreview(frame.waitText)
          expect(isKnownReadyPromptBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
            false
          )
        }
      }
      // Presence precondition for the text-copy fixtures: the text rules alone would say ready here.
      if (name === PLAIN || name === FRESH_HOME) {
        expect(sawTextOnlyReadiness).toBe(true)
      }
    }
  )

  // Why these sizes: grids out of step with the 120x40 recording garble the header (review of #23475).
  describe.each([
    [120, 40],
    [80, 24],
    [30, 50],
    [108, 30],
    [60, 5]
  ])('at %ix%i the screen never takes a settled header away from the text rules', (cols, rows) => {
    it.each(ALL_FIXTURES)('%s', async (name) => {
      let settledFrames = 0
      for await (const frame of replayTranscript(readRuntimeFixture(name), cols, rows)) {
        if (isKnownReadyPromptSettled(frame.waitText)) {
          settledFrames += 1
          expect(isKnownReadyPromptBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
            true
          )
        }
      }
      // Presence precondition: the text-copy fixtures reach a settled header.
      if (name === PLAIN || name === FRESH_HOME || name === NO_DAEMON) {
        expect(settledFrames).toBeGreaterThan(0)
      }
    })
  })

  it('keeps the text rules when there is no live screen', async () => {
    const { waitText } = await finalFrame(PLAIN, 120, 40)
    expect(isKnownReadyPromptBody(waitText, 'codex', () => null)).toBe(
      isKnownReadyPromptPreview(waitText)
    )
    expect(isKnownReadyPromptBody(waitText, 'codex', () => null)).toBe(true)
  })

  it('does not read a mid-turn composer as ready', () => {
    const screenLines = [
      '› Summarize the repository layout',
      '• Working (12s • esc to interrupt)',
      '› Ask Codex to do anything',
      '  GPT-6-Sol high · ~/repo/app'
    ]
    expect(isKnownReadyPromptBody(screenLines.join('\n'), 'codex', () => screenLines)).toBe(false)
  })

  it('does not settle when a blocking dialog is painted below the header', () => {
    const screenLines = [
      '│ >_ OpenAI Codex (v0.157.1)                               │',
      '│ model:       GPT-6-Sol high   /model to change           │',
      '│ directory:   ~/repo/app                                  │',
      'Do you trust the contents of this directory?',
      'Press enter to continue'
    ]
    expect(isKnownReadyPromptBody('', 'codex', () => screenLines)).toBe(false)
  })

  it('reads only the header box, not chat below it that mentions Codex', () => {
    const screenLines = [
      '╭──────────────────────────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.157.1)                               │',
      '│ model:       GPT-6-Sol high   /model to change           │',
      '│ directory:   ~/repo/app                                  │',
      '╰──────────────────────────────────────────────────────────╯',
      '› Why does OpenAI Codex print model: loading at startup?'
    ]
    expect(isKnownReadyPromptBody('', 'codex', () => screenLines)).toBe(true)
  })

  it('leaves a non-codex pane on the text rules even when its screen shows the Codex header', () => {
    const screenLines = [
      '│ >_ OpenAI Codex (v0.157.1)                               │',
      '│ model:       GPT-6-Sol high   /model to change           │',
      '│ directory:   ~/repo/app                                  │'
    ]
    const readScreenLines = vi.fn(() => screenLines)
    expect(isKnownReadyPromptBody('', 'claude', readScreenLines)).toBe(false)
    expect(readScreenLines).not.toHaveBeenCalled()
    expect(isKnownReadyPromptBody('', 'codex', readScreenLines)).toBe(true)
  })

  describe('at the 80x24 default grid the header garbles and today’s answer stands', () => {
    it.each(ALL_FIXTURES)('%s', async (name) => {
      const { screenLines, waitText } = await finalFrame(name, 80, 24)
      expect(isKnownReadyPromptBody(waitText, 'codex', () => screenLines)).toBe(
        isKnownReadyPromptPreview(waitText)
      )
    })
  })

  describe('through the runtime', () => {
    async function codexPane(name: string, size?: { cols: number; rows: number }) {
      return createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: readRuntimeFixture(name),
        size
      })
    }

    it.each(ALL_FIXTURES)(
      '%s: a tui-idle wait settles from the live screen',
      async (name) => {
        const { runtime, handle } = await codexPane(name, { cols: 120, rows: 40 })
        // Why 5s: the poll re-reads the grid every 2s once the queued emulator write lands.
        await expect(
          runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
        ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
      },
      15_000
    )

    it('does not settle while Codex is still installing its daemon behind the provisional screen', async () => {
      const data = readRuntimeFixture(FRESH_HOME)
      const install = data.indexOf('Installing daemon')
      // Presence precondition: the cut keeps the provisional header and stops before the live chat.
      expect(install).toBeGreaterThan(0)
      const provisional = data.slice(0, data.indexOf('\n', install) + 1)
      expect(provisional).toMatch(/model:.*loading/)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: provisional,
        size: { cols: 120, rows: 40 }
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).rejects.toThrow(/timeout/)
    }, 15_000)

    // Why no bytes: worker-start waits on a pane that has printed nothing yet, which is when the
    // runtime asks for a visible-screen read instead of its own text copy.
    it('does not settle from a visible-screen read of the provisional screen', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: '',
        size: { cols: 120, rows: 40 }
      })
      const readVisibleScreen = vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
        handle,
        status: 'running',
        tail: [
          '╭──────────────────────────────────────────╮',
          '│ >_ OpenAI Codex (v0.157.0)               │',
          '│ model:       loading   /model to change  │',
          '│ directory:   ~/repo/app                  │',
          '╰──────────────────────────────────────────╯',
          '› Ask Codex to do anything',
          '  ? for shortcuts'
        ],
        truncated: false,
        nextCursor: null,
        source: 'screen'
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).rejects.toThrow(/timeout/)
      // Presence precondition: the visible-screen probe actually ran.
      expect(readVisibleScreen).toHaveBeenCalled()
    }, 15_000)

    it('keeps timing out on the garbled 80x24 default grid, as before', async () => {
      const { runtime, handle } = await codexPane(EFFORT_OVERRIDE)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).rejects.toThrow(/timeout/)
    }, 15_000)
  })
})
