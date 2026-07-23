import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_KEYBINDING_FILE_BYTES,
  MAX_KEYBINDING_JSON_STRUCTURAL_TOKENS,
  readKeybindingFile,
  writeKeybindingOverride
} from './keybinding-file'

describe('keybinding file bounds', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-keybinding-bounds-'))
    roots.push(root)
    return join(root, 'keybindings.json')
  }

  it('parses a valid document exactly at the byte limit', () => {
    const filePath = makePath()
    const prefix = '{"padding":"'
    const suffix = '"}'
    writeFileSync(
      filePath,
      `${prefix}${'x'.repeat(MAX_KEYBINDING_FILE_BYTES - prefix.length - suffix.length)}${suffix}`
    )

    const snapshot = readKeybindingFile(filePath, 'linux')

    expect(snapshot.exists).toBe(true)
    expect(snapshot.diagnostics.some((entry) => entry.message.startsWith('Could not read'))).toBe(
      false
    )
  })

  it('rejects an oversized sparse document and never overwrites it', () => {
    const filePath = makePath()
    writeFileSync(filePath, '{}')
    truncateSync(filePath, MAX_KEYBINDING_FILE_BYTES + 1)
    const originalSize = statSync(filePath).size

    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      exists: true,
      overrides: {},
      diagnostics: [{ severity: 'error' }]
    })
    expect(() =>
      writeKeybindingOverride(filePath, 'linux', 'worktree.quickOpen', ['Ctrl+P'])
    ).toThrow()
    expect(statSync(filePath).size).toBe(originalSize)
  })

  it('rejects structurally amplified JSON before parsing', () => {
    const filePath = makePath()
    writeFileSync(filePath, `{"padding":[${'0,'.repeat(MAX_KEYBINDING_JSON_STRUCTURAL_TOKENS)}0]}`)
    const parseSpy = vi.spyOn(JSON, 'parse')

    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      exists: true,
      overrides: {},
      diagnostics: [{ severity: 'error' }]
    })
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('preserves the prior file when pretty serialization exceeds the read ceiling', () => {
    const filePath = makePath()
    const prefix = '{"padding":"'
    const suffix = '"}'
    const before = `${prefix}${'x'.repeat(
      MAX_KEYBINDING_FILE_BYTES - prefix.length - suffix.length
    )}${suffix}`
    writeFileSync(filePath, before)

    expect(() =>
      writeKeybindingOverride(filePath, 'linux', 'terminal.search', ['Ctrl+Shift+F'])
    ).toThrow('JSON output exceeds')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })
})
