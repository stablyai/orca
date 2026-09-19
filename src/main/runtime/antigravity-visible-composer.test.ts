import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { isKnownReadyTerminalScreen } from './terminal-screen-readiness'

async function capturedScreen(name: string): Promise<string[]> {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  try {
    const transcript = readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
    await new Promise<void>((resolve) => terminal.write(transcript, resolve))
    const buffer = terminal.buffer.active
    return Array.from(
      { length: terminal.rows },
      (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
    )
  } finally {
    terminal.dispose()
  }
}

describe('Antigravity visible-screen readiness from real PTY captures', () => {
  it.each([
    ['antigravity-ready-default-127', true],
    ['antigravity-ready-api-key-gemini-model', false],
    ['antigravity-ready-account-info-hidden', false],
    ['antigravity-dialog-dismissed', false],
    ['antigravity-ready-plan-127', true],
    ['antigravity-ready-accept-edits-127', true],
    ['antigravity-plan-hint-as-draft-127', false],
    ['antigravity-composer-multiline-unsent', false],
    ['antigravity-dialog-model-picker', false],
    ['antigravity-dialog-command-palette', false],
    ['antigravity-dialog-trust-workspace', false],
    ['antigravity-busy-mid-turn', false],
    ['antigravity-busy-turn-ended', true]
  ] as const)('%s is ready: %s', async (name, ready) => {
    expect(isKnownReadyTerminalScreen({ tail: await capturedScreen(name) })).toBe(ready)
  })

  it('refuses a draft extracted separately by the terminal projection', async () => {
    const tail = await capturedScreen('antigravity-ready-default-127')
    expect(isKnownReadyTerminalScreen({ tail })).toBe(true)
    expect(isKnownReadyTerminalScreen({ tail, draft: 'unfinished user message' })).toBe(false)
  })

  it('distinguishes the real mode placeholder from the same words typed by the user', async () => {
    const ready = await capturedScreen('antigravity-ready-plan-127')
    const draft = await capturedScreen('antigravity-plan-hint-as-draft-127')
    const prompt = '> Plan mode: research & plan only (shift+tab to cycle)'
    expect(ready.map((row) => row.trim())).toContain(prompt)
    expect(draft.map((row) => row.trim())).toContain(prompt)
    expect(isKnownReadyTerminalScreen({ tail: ready })).toBe(true)
    expect(isKnownReadyTerminalScreen({ tail: draft })).toBe(false)
  })
})
