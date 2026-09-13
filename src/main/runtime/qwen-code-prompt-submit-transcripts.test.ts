import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import {
  hasPendingQwenCodePastedContent,
  hasPendingQwenCodeComposerDraft,
  hasReadyQwenCodeComposer
} from './qwen-code-prompt-submit'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const ESC = String.fromCharCode(27)

async function visibleLines(name: string): Promise<string[]> {
  const transcript = readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
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

  it("recognizes Qwen's mounted visible composer", () => {
    expect(hasReadyQwenCodeComposer(['*   Type your message or @path/to/file'])).toBe(true)
  })

  it('recognizes a non-empty projected composer draft', () => {
    expect(hasPendingQwenCodeComposerDraft({ draft: 'read the target file' })).toBe(true)
    expect(hasPendingQwenCodeComposerDraft({ draft: '   ' })).toBe(false)
    expect(hasPendingQwenCodeComposerDraft({})).toBe(false)
  })
})
