import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { buildPreview } from './terminal-tail-state'
import { isKnownReadyPromptBody, isKnownReadyPromptPreview } from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

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
const ALL_FIXTURES = [PLAIN, EFFORT_OVERRIDE, CONFIG_OVERRIDE, NO_DAEMON]
const CHUNK_CHARS = 64

function readFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

type ReplayFrame = { screenLines: string[]; waitText: string }

/** Feeds the bytes the way onPtyData does: one emulator grid, one line-folded wait text. */
async function* replay(data: string, cols: number, rows: number): AsyncGenerator<ReplayFrame> {
  const emulator = new HeadlessEmulator({ cols, rows })
  let lines: string[] = []
  let partialLine = ''
  let pendingAnsi = ''
  let redrawCursor: ReturnType<typeof appendNormalizedToTailBuffer>['redrawCursor'] = null
  try {
    for (let offset = 0; offset < data.length; offset += CHUNK_CHARS) {
      const chunk = data.slice(offset, offset + CHUNK_CHARS)
      await emulator.write(chunk)
      const normalized = normalizeTerminalChunk(chunk, pendingAnsi)
      pendingAnsi = normalized.pendingAnsi
      const tail = appendNormalizedToTailBuffer(lines, partialLine, normalized.text, redrawCursor)
      lines = tail.lines
      partialLine = tail.partialLine
      redrawCursor = tail.redrawCursor
      yield {
        screenLines: projectTerminalVisibleLines(emulator).lines,
        waitText: buildTerminalWaitText(lines, partialLine, buildPreview(lines, partialLine))
      }
    }
  } finally {
    emulator.dispose()
  }
}

async function finalFrame(name: string, cols: number, rows: number): Promise<ReplayFrame> {
  let last: ReplayFrame | null = null
  for await (const frame of replay(readFixture(name), cols, rows)) {
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
      let last: ReplayFrame | null = null
      for await (const frame of replay(readFixture(name), 120, 40)) {
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

  // Why these sizes: grids out of step with the 120x40 recording garble the header (review of #23475).
  describe.each([
    [120, 40],
    [80, 24],
    [30, 50],
    [108, 30],
    [60, 5]
  ])('at %ix%i the screen never takes readiness away from the text rules', (cols, rows) => {
    it.each(ALL_FIXTURES)('%s', async (name) => {
      for await (const frame of replay(readFixture(name), cols, rows)) {
        if (isKnownReadyPromptPreview(frame.waitText)) {
          expect(isKnownReadyPromptBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
            true
          )
        }
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
        data: readFixture(name),
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

    it('keeps timing out on the garbled 80x24 default grid, as before', async () => {
      const { runtime, handle } = await codexPane(EFFORT_OVERRIDE)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).rejects.toThrow(/timeout/)
    }, 15_000)
  })
})
