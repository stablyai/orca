import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  replayTranscript,
  type TranscriptReplayFrame
} from './agent-transcript-replay-test-harness'
import { detectTerminalWaitBlockedReason, isKnownReadyPromptBody } from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type StartupDialog = {
  name: string
  reason: RuntimeTerminalWaitBlockedReason
  heading: string
  keyRow: string
}

// codex-cli 0.157.0 / 0.158.0 recordings at 120x40 on a fresh CODEX_HOME (see each .meta.json).
// Each dialog owns Enter, and none prints the `Press enter to …` wording older builds did.
const DIALOGS: StartupDialog[] = [
  {
    // Recorded separately on 0.157.1 (STA-8834).
    name: 'codex-0-157-1-update-dialog',
    reason: 'agent-update-prompt',
    heading: 'Update available ·',
    keyRow: 'enter continue · esc skip'
  },
  {
    name: 'codex-0157-update-available-dialog',
    reason: 'agent-update-prompt',
    heading: 'Update available ·',
    keyRow: 'enter continue · esc skip'
  },
  {
    name: 'codex-0158-update-available-dialog',
    reason: 'agent-update-prompt',
    heading: 'Update available ·',
    keyRow: 'enter continue · esc skip'
  },
  {
    name: 'codex-0157-hooks-review-dialog',
    reason: 'agent-hooks-review-prompt',
    heading: 'Hooks need review',
    keyRow: 'enter confirm · esc skip'
  },
  {
    name: 'codex-0158-hooks-review-dialog',
    reason: 'agent-hooks-review-prompt',
    heading: 'Hooks need review',
    keyRow: 'enter confirm · esc skip'
  },
  {
    name: 'codex-0157-model-retired-dialog',
    reason: 'codex-model-migration-prompt',
    heading: 'is no longer available',
    keyRow: 'enter/esc continue · ctrl+c quit'
  },
  {
    name: 'codex-0158-model-retired-dialog',
    reason: 'codex-model-migration-prompt',
    heading: 'is no longer offered',
    keyRow: 'enter/esc continue · ctrl+c quit'
  },
  {
    name: 'codex-0158-model-announcement-dialog',
    reason: 'codex-model-migration-prompt',
    heading: 'Try new model',
    keyRow: 'enter/esc confirm · ctrl+c quit'
  }
]
const DIALOGS_0158 = DIALOGS.filter((dialog) => dialog.name.startsWith('codex-0158-'))
const LIVE_CHAT_FIXTURES = [
  'codex-0157-plain-ready',
  'codex-0157-effort-override-embedded-warning',
  'codex-0157-config-override-embedded-warning',
  'codex-0157-no-daemon-effort-override',
  'codex-0157-fresh-home-daemon-install',
  'codex-0158-fresh-home-greeting'
]

function screenText(frame: TranscriptReplayFrame): string {
  return frame.screenLines.join('\n')
}

async function lastFrame(data: string): Promise<TranscriptReplayFrame | null> {
  let last: TranscriptReplayFrame | null = null
  for await (const frame of replayTranscript(data, 120, 40)) {
    last = frame
  }
  return last
}

// Why stitched: no capture spans answering a dialog. Codex repaints every cell once a startup
// dialog closes, so the 0.158 greeting capture's paints stand in for that repaint.
function answered(name: string): string {
  const greeting = readRuntimeFixture('codex-0158-fresh-home-greeting')
  return readRuntimeFixture(name) + greeting.slice(greeting.indexOf('\x1b[?2026h'))
}

describe('Codex 0.157/0.158 startup dialogs from captured bytes', () => {
  it.each(DIALOGS)(
    '$name: reports $reason from its key row on, and never reads ready while it is up',
    async ({ name, reason, heading, keyRow }) => {
      let headingFrames = 0
      let keyRowFrames = 0
      for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
        const screen = screenText(frame)
        if (screen.includes(heading)) {
          headingFrames += 1
          expect(isKnownReadyPromptBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
            false
          )
        }
        if (keyRowFrames > 0 || screen.includes(keyRow)) {
          keyRowFrames += 1
          expect(detectTerminalWaitBlockedReason(frame.waitText)).toBe(reason)
        }
      }
      // Presence precondition: the dialog and its key row were painted, not just parsed.
      expect(headingFrames).toBeGreaterThan(0)
      expect(keyRowFrames).toBeGreaterThan(0)
    }
  )

  it.each(DIALOGS_0158)(
    '$name: stops reporting once Codex repaints its chat after it',
    async ({ name, heading }) => {
      const last = await lastFrame(answered(name))
      // Presence precondition: the answered dialog is still in the text copy.
      expect(last?.waitText).toContain(heading.replace(' ·', ''))
      expect(detectTerminalWaitBlockedReason(last?.waitText ?? '')).toBeNull()
    }
  )

  it.each(DIALOGS)(
    '$name: still reports $reason when Codex is relaunched in the same pane and shows it again',
    async ({ name, reason }) => {
      // Why: quitting Codex from a dialog leaves that copy in the text copy ahead of the relaunch.
      const dialog = readRuntimeFixture(name)
      const last = await lastFrame(`${dialog}\x1b[?1049l\r\n% codex\r\n${dialog}`)
      expect(detectTerminalWaitBlockedReason(last?.waitText ?? '')).toBe(reason)
      expect(
        isKnownReadyPromptBody(last?.waitText ?? '', 'codex', () => last?.screenLines ?? null)
      ).toBe(false)
    }
  )

  it.each(LIVE_CHAT_FIXTURES)('%s: a live chat reports no dialog', async (name) => {
    const waitText = (await lastFrame(readRuntimeFixture(name)))?.waitText ?? ''
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
    // Why these lines: chat can name a dialog, and Codex's own update notice and footer draw `·`.
    const chat = [
      '› is there an update available, and do my hooks need review?',
      '✨ Update available! 0.158.0 -> 0.159.0',
      'Run npm install -g @openai/codex to update.',
      '  gpt-6-astra default · ~/repo',
      '  ← for agents · ? for shortcuts'
    ].join('\n')
    expect(detectTerminalWaitBlockedReason(`${waitText}\n${chat}`)).toBeNull()
  })

  it('does not name a mid-session Codex popup a hooks review', () => {
    // Why: Codex's rate-limit reset popup (and other pickers) ends `enter confirm · esc back`.
    const popup = [
      '  Use this reset?',
      '  1. Yes, use reset  Reset your weekly and 5-hour usage limits.',
      '› 2. No, go back     Choose a different reset',
      '  enter confirm · esc back'
    ].join('\n')
    expect(detectTerminalWaitBlockedReason(popup)).not.toBe('agent-hooks-review-prompt')
  })

  describe('through the runtime', () => {
    it.each(DIALOGS)(
      '$name: stops a tui-idle wait as $reason instead of typing into it',
      async ({ name, reason }) => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'codex',
          launchAgent: 'codex',
          data: readRuntimeFixture(name),
          size: { cols: 120, rows: 40 }
        })
        await expect(
          runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
        ).resolves.toMatchObject({ satisfied: false, blockedReason: reason })
      },
      15_000
    )
  })
})
