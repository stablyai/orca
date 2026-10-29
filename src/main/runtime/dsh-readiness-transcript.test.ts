import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import {
  getAgentLabel,
  isGeminiTerminalTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../shared/terminal-title-agent-type'

// Raw dsh-tui 0.10.2 / @deepseek-ai/dsh 0.1.5-rc.1 capture; agent-pty-transcript-capture.md.
const TRANSCRIPT = readFileSync(join(__dirname, '__fixtures__', 'dsh-tui-ready-no-key.txt'), 'utf8')

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

function readFirstOscTitle(data: string): string {
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
    for (let offset = 0; offset < TRANSCRIPT.length; offset += 1024) {
      const chunk = TRANSCRIPT.slice(offset, offset + 1024)
      if (scanner.observe(chunk).ready && readyAt === -1) {
        readyAt = offset + chunk.length
      }
    }
    // Composer arrives near byte 5910; do not wait for the remaining ~70KB whale animation.
    expect(readyAt).toBeGreaterThan(0)
    expect(readyAt).toBeLessThan(8192)
  })

  it('arms the quiet-window fallback from DECSET 2004 as well', () => {
    const scanner = createDraftPasteReadyScanner('dsh-composer-prompt')
    expect(scanner.observe(TRANSCRIPT.slice(0, 40)).armQuietTimer).toBe(true)
  })

  it('identifies the pane from DSH’s own title, not Gemini’s', () => {
    const title = readFirstOscTitle(TRANSCRIPT)
    expect(title).toContain('✦')
    expect(title).toContain('\u{1F40B}')
    expect(isGeminiTerminalTitle(title)).toBe(false)
    expect(getAgentLabel(title)).toBe('DeepSeek Harness')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('dsh')
  })

  it('keeps a working DSH title out of Claude’s braille-spinner lane', () => {
    // DSH working braille overlaps Claude's spinner glyphs.
    for (const frame of ['⠂', '⠐']) {
      const working = `${frame} \u{1F40B} fix the flaky test`
      expect(getAgentLabel(working)).toBe('DeepSeek Harness')
    }
  })
})
