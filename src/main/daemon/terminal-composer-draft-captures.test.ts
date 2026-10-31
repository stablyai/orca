import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'

// Captured verbatim from Claude Code 2.1.246 and Codex 0.149.1 in a 100x30 PTY.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

describe('detectTerminalComposerDraft against real agent screens', () => {
  let emulator: HeadlessEmulator

  afterEach(() => {
    emulator?.dispose()
  })

  async function detect(name: string): Promise<string | null> {
    emulator = new HeadlessEmulator({ cols: 100, rows: 30 })
    await emulator.write(fixture(name))
    return detectTerminalComposerDraft(emulator.getCursorLineContext())?.text ?? null
  }

  it.each(['claude-composer-draft', 'codex-composer-draft'])(
    'reads the unsent draft in %s',
    async (name) => {
      await expect(detect(name)).resolves.toBe('Refactor the login page so that it')
      expect(emulator.getCursorLineContext()).toMatchObject({ cursorHidden: false })
    }
  )

  // Why: both agents draw a dialog's selected option with the composer glyph but hide
  // the cursor while the dialog is open — evidence draft text cannot fake.
  it.each(['claude-permission-dialog', 'codex-trust-dialog'])(
    'does not read the dialog option list in %s as a draft',
    async (name) => {
      await expect(detect(name)).resolves.toBeNull()
      expect(emulator.getCursorLineContext()).toMatchObject({ cursorHidden: true })
    }
  )
})
