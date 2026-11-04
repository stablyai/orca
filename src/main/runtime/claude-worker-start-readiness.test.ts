import { describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('the Claude composer marker', () => {
  const firesOn = (fixture: string): boolean => {
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    return scanner.observe(readRuntimeFixture(fixture)).ready
  }

  it('does not fire on the workspace-trust menu, which draws the same pointer', () => {
    expect(readRuntimeFixture('claude-dialog-trust-workspace')).toContain('❯')
    expect(firesOn('claude-dialog-trust-workspace')).toBe(false)
  })

  // A powerlevel10k/starship prompt draws the same `❯` + NBSP after the shell's own DECSET 2004.
  const SHELL_PROMPT = '\x1b[?2004h~/repo \x1b[32m❯ \x1b[0m'

  it('does not fire on a shell prompt that draws the same glyph', () => {
    // Presence precondition: the shell turns bracketed paste on just as Claude does.
    expect(readRuntimeFixture('zsh-prompt-runs-command')).toContain('\x1b[?2004h')
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    expect(scanner.observe(readRuntimeFixture('zsh-prompt-runs-command')).ready).toBe(false)
    expect(scanner.observe(SHELL_PROMPT).ready).toBe(false)
  })
})
