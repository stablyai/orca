import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  replayTranscript,
  type TranscriptReplayFrame
} from './agent-transcript-replay-test-harness'
import {
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isKnownReadyPromptSettled,
  isQuietReadyScreenBody
} from './terminal-wait-detection'
import { waitForLaunchedAgentComposer } from './launched-agent-composer-readiness'
import { clearWorkingIndicators } from '../../shared/agent-title-status'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Codex captured header readiness', () => {
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
        // STA-8628: cell-diff repaint folds to dirctory:.
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
            expect(isQuietReadyScreenBody('', 'codex', () => frame.screenLines)).toBe(false)
          }
          last = frame
        }
        expect(sawLoadingHeader).toBe(true)
        expect(last).not.toBeNull()
        expect(isQuietReadyScreenBody(last!.waitText, 'codex', () => last!.screenLines)).toBe(true)
      }
    )

    // 0.157 discards input while its provisional daemon-start header is displayed.
    it.each(ALL_FIXTURES)(
      '%s: never ready while the screen shows the provisional `model: loading` startup screen',
      async (name) => {
        let sawTextOnlyReadiness = false
        for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
          if (screenShowsProvisionalStartup(frame.screenLines)) {
            sawTextOnlyReadiness ||= isKnownReadyPromptPreview(frame.waitText)
            expect(isQuietReadyScreenBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
              false
            )
            expect(
              isKnownReadyPromptBody(frame.waitText, null, () => frame.screenLines, true)
            ).toBe(false)
          }
        }
        if (name === PLAIN || name === FRESH_HOME) {
          expect(sawTextOnlyReadiness).toBe(true)
        }
      }
    )

    // Grids mismatched with the 120x40 recording garble the header (#23475).
    describe.each([
      [120, 40],
      [80, 24],
      [30, 50],
      [108, 30],
      [60, 5]
    ])(
      'at %ix%i the screen never takes a settled header away from the text rules',
      (cols, rows) => {
        it.each(ALL_FIXTURES)('%s', async (name) => {
          let settledFrames = 0
          for await (const frame of replayTranscript(readRuntimeFixture(name), cols, rows)) {
            if (isKnownReadyPromptSettled(frame.waitText)) {
              settledFrames += 1
              expect(isQuietReadyScreenBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
                true
              )
            }
          }
          if (name === PLAIN || name === FRESH_HOME || name === NO_DAEMON) {
            expect(settledFrames).toBeGreaterThan(0)
          }
        })
      }
    )

    it('keeps the text rules when there is no live screen', async () => {
      const { waitText } = await finalFrame(PLAIN, 120, 40)
      expect(isQuietReadyScreenBody(waitText, 'codex', () => null)).toBe(
        isKnownReadyPromptPreview(waitText)
      )
      expect(isQuietReadyScreenBody(waitText, 'codex', () => null)).toBe(true)
    })

    it('does not read a mid-turn composer as ready', () => {
      const screenLines = [
        '› Summarize the repository layout',
        '• Working (12s • esc to interrupt)',
        '› Ask Codex to do anything',
        '  GPT-6-Sol high · ~/repo/app'
      ]
      expect(isQuietReadyScreenBody(screenLines.join('\n'), 'codex', () => screenLines)).toBe(false)
    })

    it('does not settle when a blocking dialog is painted below the header', () => {
      const screenLines = [
        '│ >_ OpenAI Codex (v0.157.1)                               │',
        '│ model:       GPT-6-Sol high   /model to change           │',
        '│ directory:   ~/repo/app                                  │',
        'Do you trust the contents of this directory?',
        'Press enter to continue'
      ]
      expect(isQuietReadyScreenBody('', 'codex', () => screenLines)).toBe(false)
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
      expect(isQuietReadyScreenBody('', 'codex', () => screenLines)).toBe(true)
    })

    it('never reads a non-codex screen, even one showing the Codex header', () => {
      const screenLines = [
        '│ >_ OpenAI Codex (v0.157.1)                               │',
        '│ model:       GPT-6-Sol high   /model to change           │',
        '│ directory:   ~/repo/app                                  │'
      ]
      const readScreenLines = vi.fn(() => screenLines)
      expect(isQuietReadyScreenBody('', 'claude', readScreenLines)).toBe(false)
      expect(readScreenLines).not.toHaveBeenCalled()
      expect(isQuietReadyScreenBody('', 'codex', readScreenLines)).toBe(true)
    })

    describe('at the 80x24 default grid the header garbles and today’s answer stands', () => {
      it.each(ALL_FIXTURES)('%s', async (name) => {
        const { screenLines, waitText } = await finalFrame(name, 80, 24)
        expect(isQuietReadyScreenBody(waitText, 'codex', () => screenLines)).toBe(
          isKnownReadyPromptPreview(waitText)
        )
      })
    })

    describe('through the runtime', () => {
      async function codexPane(name: string, size?: { cols: number; rows: number }) {
        const created = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'codex',
          launchAgent: 'codex',
          data: readRuntimeFixture(name),
          size
        })
        await created.runtime.readTerminal(created.handle, { screen: true })
        return created
      }

      it.each(ALL_FIXTURES)(
        '%s: a tui-idle wait settles from the live screen',
        async (name) => {
          const { runtime, handle } = await codexPane(name, { cols: 120, rows: 40 })
          // Allow 3s quiescence plus the 2s grid poll.
          await expect(waitForTranscriptIdle({ runtime, handle }, 8_000)).resolves.toMatchObject({
            condition: 'tui-idle',
            satisfied: true
          })
        },
        15_000
      )

      it('does not settle while Codex is still installing its daemon behind the provisional screen', async () => {
        const data = readRuntimeFixture(FRESH_HOME)
        const install = data.indexOf('Installing daemon')
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
        await runtime.readTerminal(handle, { screen: true })
        // Past 3s quiescence: the provisional-header veto must still hold.
        await expect(waitForTranscriptIdle({ runtime, handle }, 6_000)).rejects.toThrow(/timeout/)
      }, 15_000)

      // No output forces worker-start to probe the visible screen instead of folded text.
      it('does not settle from a visible-screen read of the provisional screen', async () => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'codex',
          launchAgent: 'codex',
          data: '',
          size: { cols: 120, rows: 40 }
        })
        await runtime.readTerminal(handle, { screen: true })
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
        await expect(waitForTranscriptIdle({ runtime, handle }, 2_500)).rejects.toThrow(/timeout/)
        expect(readVisibleScreen).toHaveBeenCalled()
      }, 15_000)

      // Restored bytes have no lastOutputAt, so no quiet clock can expire.
      it('settles a restored Codex pane from its header, as main did', async () => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'codex',
          launchAgent: 'codex',
          data: ''
        })
        await runtime.readTerminal(handle, { screen: true })
        runtime.seedTerminalRestoreTail(TRANSCRIPT_PANE_PTY_ID, {
          text: [
            '╭──────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.157.1)               │',
            '│ model:       gpt-6-sol high   /model to change │',
            '│ directory:   ~/repo/app                  │',
            '╰──────────────────────────────────────────╯',
            '› Ask Codex to do anything',
            '  gpt-6-sol high · ~/repo/app'
          ].join('\r\n')
        })
        // Withhold visible-screen readiness to isolate the intended lane.
        vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
          handle,
          status: 'running',
          tail: [],
          truncated: false,
          nextCursor: null,
          source: 'screen-unavailable'
        })
        await expect(waitForTranscriptIdle({ runtime, handle }, 2_500)).resolves.toMatchObject({
          condition: 'tui-idle',
          satisfied: true
        })
      }, 15_000)

      it('keeps timing out on the garbled 80x24 default grid, as before', async () => {
        const { runtime, handle } = await codexPane(EFFORT_OVERRIDE)
        await expect(waitForTranscriptIdle({ runtime, handle }, 6_000)).rejects.toThrow(/timeout/)
      }, 15_000)
    })
  })
})

describe('Codex launched composer readiness', () => {
  // Source-control multiline prompts depend on this readiness wait before delivery.
  async function launchedCodexPane(data: string) {
    return createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'codex',
      launchAgent: 'codex',
      data,
      size: { cols: 120, rows: 40 }
    })
  }

  async function waitForCodexComposer(
    pane: Awaited<ReturnType<typeof launchedCodexPane>>,
    timeoutMs: number,
    streamedData?: string
  ) {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    try {
      const ready = waitForLaunchedAgentComposer(pane.runtime, pane.handle, 'codex', timeoutMs)
      void ready.catch(() => {})
      if (streamedData !== undefined) {
        pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, streamedData, Date.now())
      }
      await vi.advanceTimersByTimeAsync(timeoutMs + 1)
      return await ready
    } finally {
      vi.useRealTimers()
    }
  }

  // Cut before Astra's 150ms composer star animation; replaying its first frozen frame would misrepresent the live stream.
  function greetingBeforeStarfield(): string {
    const data = readRuntimeFixture('codex-0158-fresh-home-greeting')
    const firstStar = data.search(/38;2;\d+;\d+;\d+;48;2;30;30;30m[⠀-⣿]/)
    return data.slice(0, data.lastIndexOf('\x1b[?2026h', firstStar))
  }

  describe('launch readiness for a freshly launched Codex', () => {
    it('codex-0158-fresh-home-greeting: reads the live chat as ready for launch', async () => {
      const data = greetingBeforeStarfield()
      expect(data).toContain('GPT-6-Astra default')
      expect(data).not.toMatch(/48;2;30;30;30m[⠀-⣿]/)
      const pane = await launchedCodexPane(data)
      await expect(waitForCodexComposer(pane, 8_000)).resolves.toMatchObject({
        condition: 'tui-idle',
        satisfied: true
      })
    }, 15_000)

    it('codex-0157-plain-ready: reads the live chat as ready for launch', async () => {
      const pane = await launchedCodexPane(readRuntimeFixture('codex-0157-plain-ready'))
      await expect(waitForCodexComposer(pane, 8_000)).resolves.toMatchObject({
        condition: 'tui-idle',
        satisfied: true
      })
    }, 15_000)

    it.each([
      ['codex-0158-update-available-dialog', 'agent-update-prompt'],
      ['codex-0158-hooks-review-dialog', 'agent-hooks-review-prompt'],
      ['codex-0158-model-retired-dialog', 'codex-model-migration-prompt'],
      ['codex-0158-model-announcement-dialog', 'codex-model-migration-prompt']
    ])(
      '%s: stops at the dialog as %s instead of pasting into it',
      async (fixture, reason) => {
        const pane = await launchedCodexPane(readRuntimeFixture(fixture))
        await expect(waitForCodexComposer(pane, 2_500)).resolves.toMatchObject({
          satisfied: false,
          blockedReason: reason
        })
      },
      15_000
    )

    // Dialog selectors also emit the composer glyph after bracketed paste; only the screen veto prevents pasting.
    it.each([
      ['codex-0157-update-available-dialog', 'agent-update-prompt'],
      ['codex-0158-update-available-dialog', 'agent-update-prompt'],
      ['codex-0158-hooks-review-dialog', 'agent-hooks-review-prompt'],
      ['codex-0158-model-retired-dialog', 'codex-model-migration-prompt'],
      ['codex-0158-model-announcement-dialog', 'codex-model-migration-prompt']
    ])(
      '%s streamed in after the launch: reports the dialog as %s, never as the composer',
      async (fixture, reason) => {
        const data = readRuntimeFixture(fixture)
        expect(data.slice(data.indexOf('\x1b[?2004h'))).toContain('›')
        const pane = await launchedCodexPane('')
        await expect(waitForCodexComposer(pane, 2_500, data)).resolves.toMatchObject({
          satisfied: false,
          blockedReason: reason
        })
      },
      15_000
    )

    // 0.157 discards input behind its provisional header; allow the readiness timeout to prove the veto.
    it('codex-0157-fresh-home-daemon-install: does not read the provisional screen as ready', async () => {
      const full = readRuntimeFixture('codex-0157-fresh-home-daemon-install')
      const install = full.indexOf('Installing daemon')
      expect(install).toBeGreaterThan(0)
      const provisional = full.slice(0, full.indexOf('\n', install) + 1)
      expect(provisional).toMatch(/model:.*loading/)
      const pane = await launchedCodexPane(provisional)
      await expect(waitForCodexComposer(pane, 5_000)).rejects.toThrow(/timeout/)
    }, 15_000)
  })
})

describe('Display title clearing and live agent presence', () => {
  // Synthetic protocol cases separate title readiness/display/presence; 3s clears only stale display.
  describe('the stale-working title clear is display-only', () => {
    it.each([
      ['claude', '. claude', '* claude'],
      ['codex', '⠋ Codex working', 'Codex ready'],
      ['gemini', '✦ Gemini CLI', '◇ Gemini CLI'],
      ['opencode', '⠋ OC | task', 'OC | task'],
      ['pi', 'π : project', 'π - project']
    ] as const)(
      '%s does not become ready when its display title clears',
      async (agent, busy, idle) => {
        vi.useFakeTimers()
        try {
          const titleChanges: string[] = []
          const { runtime, handle } = await createTranscriptPane(
            {
              paneTitle: busy,
              foregroundProcess: agent,
              data: '',
              launchAgent: agent
            },
            {
              onTerminalSideEffects: (batch) => {
                for (const fact of batch.facts) {
                  if (fact.kind === 'title') {
                    titleChanges.push(fact.normalizedTitle)
                  }
                }
              }
            }
          )
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${busy}\x07`, Date.now())
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'still running\r\n', Date.now())
          await vi.advanceTimersByTimeAsync(3_000)
          expect(titleChanges.at(-1)).toBe(clearWorkingIndicators(busy))
          runtime.syncWindowGraph(1, {
            tabs: [
              {
                tabId: 'tab-1',
                worktreeId: 'wt-1',
                title: clearWorkingIndicators(busy),
                activeLeafId: '11111111-1111-4111-8111-111111111111',
                layout: null
              }
            ],
            leaves: [
              {
                tabId: 'tab-1',
                worktreeId: 'wt-1',
                leafId: '11111111-1111-4111-8111-111111111111',
                paneRuntimeId: 1,
                ptyId: TRANSCRIPT_PANE_PTY_ID,
                paneTitle: clearWorkingIndicators(busy)
              }
            ]
          })
          const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 200 })
          const assertion = expect(waiting).rejects.toThrow('timeout')
          await Promise.all([assertion, vi.advanceTimersByTimeAsync(200)])
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${idle}\x07`, Date.now())
          const ready = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
          const readyAssertion = expect(ready).resolves.toMatchObject({ satisfied: true })
          await Promise.all([readyAssertion, vi.advanceTimersByTimeAsync(2_000)])
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it.each([['⠋ repo']])(
      'an agent that exited behind %s does not pass for a running agent',
      async (title) => {
        vi.useFakeTimers()
        try {
          const { runtime, handle } = await createTranscriptPane({
            paneTitle: 'Terminal',
            foregroundProcess: 'zsh',
            data: ''
          })
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${title}\x07`, Date.now())
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]133;D;0\x07\x1b]133;A\x07% ', Date.now())
          await vi.advanceTimersByTimeAsync(3_000)
          await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
            isRunningAgent: false,
            status: null
          })
          await expect(
            runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
          ).resolves.toBe(false)
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it('a live agent behind a cleared title is still found by its process', async () => {
      vi.useFakeTimers()
      try {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'codex',
          data: ''
        })
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠋ repo\x07', Date.now())
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'still running\r\n', Date.now())
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
          isRunningAgent: true,
          status: null
        })
        await expect(
          runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
        ).resolves.toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("the agent's next genuine title proves presence again", async () => {
      vi.useFakeTimers()
      try {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: null,
          data: ''
        })
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠋ repo\x07', Date.now())
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'still running\r\n', Date.now())
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
          isRunningAgent: false
        })
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠙ repo\x07', Date.now())
        await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
          isRunningAgent: true,
          status: 'working'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('a live Cursor spinner title proves presence when no foreground read can answer', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: null,
        data: ''
      })
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠋ Cursor Agent\x07', Date.now())
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'working'
      })
    })
  })
})
