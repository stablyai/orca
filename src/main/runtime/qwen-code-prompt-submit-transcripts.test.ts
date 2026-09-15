import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { hasPendingQwenCodePastedContent } from './qwen-code-prompt-submit'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const ESC = String.fromCharCode(27)

async function visibleLines(name: string): Promise<string[]> {
  const transcript = readTranscript(name)
  expect(transcript).toContain(ESC)
  const { runtime } = await createTranscriptPane({
    paneTitle: 'Qwen - fixture',
    foregroundProcess: 'qwen',
    data: transcript
  })
  const readVisibleTerminalState = Reflect.get(runtime, 'readVisibleTerminalState')
  expect(readVisibleTerminalState).toBeTypeOf('function')
  const visible: unknown = await Reflect.apply(readVisibleTerminalState, runtime, [
    TRANSCRIPT_PANE_PTY_ID
  ])
  if (!visible || typeof visible !== 'object' || !('lines' in visible)) {
    return []
  }
  return Array.isArray(visible.lines)
    ? visible.lines.filter((line): line is string => typeof line === 'string')
    : []
}

function readTranscript(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
}

describe('Qwen Code prompt submission, decided by captured transcripts', () => {
  it('recognizes a large paste whose first Enter was swallowed', async () => {
    await expect(
      visibleLines('qwen-code-windows-large-paste-submit-swallowed').then(
        hasPendingQwenCodePastedContent
      )
    ).resolves.toBe(true)
  })

  it('does not retry after Qwen accepted the prompt and began its turn', async () => {
    await expect(
      visibleLines('qwen-code-windows-large-paste-submitted').then(hasPendingQwenCodePastedContent)
    ).resolves.toBe(false)
  })

  it("recognizes Qwen's composer-ready control sequence in a captured PTY transcript", () => {
    const signal = TUI_AGENT_CONFIG['qwen-code'].draftPasteReadySignal
    expect(signal).toBe('render-cursor-after-bracketed-paste')
    if (!signal) {
      throw new Error('Qwen Code has no draft-paste readiness signal')
    }
    const scanner = createDraftPasteReadyScanner(signal)
    expect(scanner.observe(readTranscript('qwen-code-windows-large-paste-submitted'))).toEqual({
      ready: true,
      armQuietTimer: false
    })
  })
})
