import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { waitForLaunchedAgentComposer } from './launched-agent-composer-readiness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// A source-control button's multi-line prompt reaches Codex only through this wait, so a Codex
// release that the launch wait cannot read ready reports "prompt wasn't sent".
async function launchedCodexPane(data: string) {
  return createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'codex',
    launchAgent: 'codex',
    data,
    size: { cols: 120, rows: 40 }
  })
}

// Why cut: on an Astra model 0.158 sparkles braille stars in the empty composer, redrawing every
// 150 ms, then repaints it clean after 15 s. The capture ends on the first star frame, so replayed
// whole it holds a starred composer still, which the live stream never does.
function greetingBeforeStarfield(): string {
  const data = readRuntimeFixture('codex-0158-fresh-home-greeting')
  const firstStar = data.search(/38;2;\d+;\d+;\d+;48;2;30;30;30m[⠀-⣿]/)
  return data.slice(0, data.lastIndexOf('\x1b[?2026h', firstStar))
}

describe('launch readiness for a freshly launched Codex', () => {
  it('codex-0158-fresh-home-greeting: reads the live chat as ready, so the prompt is pasted', async () => {
    const data = greetingBeforeStarfield()
    // Presence precondition: the cut keeps the live status row and drops every star.
    expect(data).toContain('GPT-6-Astra default')
    expect(data).not.toMatch(/48;2;30;30;30m[⠀-⣿]/)
    const { runtime, handle } = await launchedCodexPane(data)
    await expect(
      waitForLaunchedAgentComposer(runtime, handle, 'codex', 8_000)
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  }, 15_000)

  it('codex-0157-plain-ready: reads the live chat as ready, so the prompt is pasted', async () => {
    const { runtime, handle } = await launchedCodexPane(
      readRuntimeFixture('codex-0157-plain-ready')
    )
    await expect(
      waitForLaunchedAgentComposer(runtime, handle, 'codex', 8_000)
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  }, 15_000)

  it.each([
    ['codex-0158-update-available-dialog', 'agent-update-prompt'],
    ['codex-0158-hooks-review-dialog', 'agent-hooks-review-prompt'],
    ['codex-0158-model-retired-dialog', 'codex-model-migration-prompt'],
    ['codex-0158-model-announcement-dialog', 'codex-model-migration-prompt']
  ])(
    '%s: stops at the dialog as %s instead of pasting into it',
    async (fixture, reason) => {
      const { runtime, handle } = await launchedCodexPane(readRuntimeFixture(fixture))
      await expect(
        waitForLaunchedAgentComposer(runtime, handle, 'codex', 2_500)
      ).resolves.toMatchObject({ satisfied: false, blockedReason: reason })
    },
    15_000
  )

  // Why streamed: live, the dialog's `›` selector arrives after bracketed paste and fires the
  // composer signal, so only the screen check keeps it from pasting; it hands the dialog to
  // `tui-idle` to report, well inside the desktop paste's budget.
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
      // Presence precondition: the dialog draws Codex's composer glyph after bracketed paste.
      expect(data.slice(data.indexOf('\x1b[?2004h'))).toContain('›')
      const { runtime, handle } = await launchedCodexPane('')
      const ready = waitForLaunchedAgentComposer(runtime, handle, 'codex', 2_500)
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
      await expect(ready).resolves.toMatchObject({ satisfied: false, blockedReason: reason })
    },
    15_000
  )

  // Why: 0.157 discards input typed behind its provisional `model: loading` screen.
  it('codex-0157-fresh-home-daemon-install: does not read the provisional screen as ready', async () => {
    const full = readRuntimeFixture('codex-0157-fresh-home-daemon-install')
    const install = full.indexOf('Installing daemon')
    // Presence precondition: the cut keeps the provisional header and stops before the live chat.
    expect(install).toBeGreaterThan(0)
    const provisional = full.slice(0, full.indexOf('\n', install) + 1)
    expect(provisional).toMatch(/model:.*loading/)
    const { runtime, handle } = await launchedCodexPane(provisional)
    await expect(waitForLaunchedAgentComposer(runtime, handle, 'codex', 5_000)).rejects.toThrow(
      /timeout/
    )
  }, 15_000)
})
