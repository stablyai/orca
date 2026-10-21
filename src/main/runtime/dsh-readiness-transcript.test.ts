import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import {
  getAgentLabel,
  isGeminiTerminalTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../shared/terminal-title-agent-type'

// The committed capture of a real `dsh-tui` 0.10.2 launch on @deepseek-ai/dsh 0.1.5-rc.1.
// Every rule below is written against these bytes rather than a remembered screen; see
// docs/reference/agent-pty-transcript-capture.md.
const TRANSCRIPT = readFileSync(join(__dirname, '__fixtures__', 'dsh-tui-ready-no-key.txt'), 'utf8')

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** The OSC 0 title DSH-TUI sets, read back out of the capture. */
function readFirstOscTitle(data: string): string {
  // Indexed scan rather than a regex: the delimiters are control characters.
  const open = data.indexOf(`${ESC}]0;`)
  const bodyStart = open === -1 ? -1 : open + 4
  const terminator = bodyStart === -1 ? -1 : data.indexOf(BEL, bodyStart)
  if (terminator === -1) {
    throw new Error('the captured transcript carries no BEL-terminated OSC 0 title')
  }
  return data.slice(bodyStart, terminator)
}

describe('DSH-TUI readiness from captured terminal bytes', () => {
  it('fires the composer-ready signal well before the transcript ends', () => {
    const scanner = createDraftPasteReadyScanner('dsh-composer-prompt')
    let readyAt = -1
    // Feed it in PTY-sized chunks so a marker split across chunk boundaries is exercised.
    for (let offset = 0; offset < TRANSCRIPT.length; offset += 1024) {
      const chunk = TRANSCRIPT.slice(offset, offset + 1024)
      if (scanner.observe(chunk).ready && readyAt === -1) {
        readyAt = offset + chunk.length
      }
    }
    // The composer glyph lands at byte 5910 of ~70KB: readiness must not wait out the
    // whale intro that keeps painting behind it (the grok failure mode this signal fixes).
    expect(readyAt).toBeGreaterThan(0)
    expect(readyAt).toBeLessThan(8192)
  })

  it('arms the quiet-window fallback from DECSET 2004 as well', () => {
    const scanner = createDraftPasteReadyScanner('dsh-composer-prompt')
    expect(scanner.observe(TRANSCRIPT.slice(0, 40)).armQuietTimer).toBe(true)
  })

  it('identifies the pane from DSH’s own title, not Gemini’s', () => {
    const title = readFirstOscTitle(TRANSCRIPT)
    // DSH-TUI's idle prefix is `✦`, which is Gemini CLI's WORKING glyph.
    expect(title).toContain('✦')
    expect(title).toContain('\u{1F40B}')
    expect(isGeminiTerminalTitle(title)).toBe(false)
    expect(getAgentLabel(title)).toBe('DeepSeek Harness')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('dsh')
  })

  it('keeps a working DSH title out of Claude’s braille-spinner lane', () => {
    // `titlePrefix` cycles through `⠂`/`⠐` while a turn runs (Chat.js
    // TITLE_SPINNER_FRAMES), both of which are in the braille block Claude claims.
    for (const frame of ['⠂', '⠐']) {
      const working = `${frame} \u{1F40B} fix the flaky test`
      expect(getAgentLabel(working)).toBe('DeepSeek Harness')
    }
  })
})
