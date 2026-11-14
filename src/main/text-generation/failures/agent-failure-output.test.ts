import { describe, expect, it } from 'vitest'
import {
  captureAgentGenerationFailureOutput,
  formatAgentGenerationFailureOutputForDisplay
} from './agent-failure-output'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('captureAgentGenerationFailureOutput', () => {
  it('bounds an oversized stream to its head and tail with an omission marker', () => {
    const oversized = `${'h'.repeat(20_000)}${'m'.repeat(40_000)}${'t'.repeat(50_000)}`
    const capture = captureAgentGenerationFailureOutput('Pi', 1, '', oversized)
    const stderr = capture?.stderr ?? ''
    expect(stderr.startsWith('h'.repeat(16 * 1024))).toBe(true)
    expect(stderr.endsWith('t'.repeat(48 * 1024))).toBe(true)
    expect(stderr).toContain('characters omitted')
    expect(stderr.length).toBeLessThan(oversized.length)
  })
})

describe('formatAgentGenerationFailureOutputForDisplay', () => {
  it('strips ANSI, OSC, and bidi-override characters while keeping line structure', () => {
    const text = formatAgentGenerationFailureOutputForDisplay({
      label: 'Pi',
      exitCode: 1,
      stdout: '',
      stderr: `${ESC}]0;title${BEL}${ESC}[91mline one${ESC}[0m\r\nsafe ${String.fromCharCode(0x202e)}evil${String.fromCharCode(0x202c)} tail\rline three`
    })
    expect(text).toBe('Pi exited with code 1.\n\n[stderr]\nline one\nsafe evil tail\nline three')
  })

  it('keeps later diagnostics when an OSC sequence is unterminated', () => {
    const text = formatAgentGenerationFailureOutputForDisplay({
      label: 'Pi',
      exitCode: 1,
      stdout: '',
      stderr: `${ESC}]0;unfinished title\nNo API key found.\nUse /login to log in.`
    })
    expect(text).toContain('No API key found.\nUse /login to log in.')
  })
})
