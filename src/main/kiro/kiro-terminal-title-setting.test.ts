import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enableKiroTerminalTitle } from './kiro-terminal-title-setting'

function settingsPathIn(dir = mkdtempSync(join(tmpdir(), 'kiro-settings-'))): string {
  return join(dir, 'nested', 'cli.json')
}

describe('enableKiroTerminalTitle', () => {
  it('creates the settings file when Kiro has never written one', () => {
    const path = settingsPathIn()
    expect(enableKiroTerminalTitle(path)).toBe('enabled')
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ 'chat.terminalTitle': true })
  })

  it('preserves every other key the user has set', () => {
    const path = settingsPathIn()
    enableKiroTerminalTitle(path)
    writeFileSync(
      path,
      JSON.stringify({ 'autocomplete.theme': 'dark', 'mcp.loadedBefore': true }),
      'utf-8'
    )
    expect(enableKiroTerminalTitle(path)).toBe('enabled')
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      'autocomplete.theme': 'dark',
      'mcp.loadedBefore': true,
      'chat.terminalTitle': true
    })
  })

  it('does not re-enable a value the user turned off', () => {
    const path = settingsPathIn()
    enableKiroTerminalTitle(path)
    writeFileSync(path, JSON.stringify({ 'chat.terminalTitle': false }), 'utf-8')
    expect(enableKiroTerminalTitle(path)).toBe('already-set')
    expect(JSON.parse(readFileSync(path, 'utf-8'))['chat.terminalTitle']).toBe(false)
  })

  it('leaves a file it cannot parse alone', () => {
    const path = settingsPathIn()
    enableKiroTerminalTitle(path)
    writeFileSync(path, '{ not json', 'utf-8')
    expect(enableKiroTerminalTitle(path)).toBe('failed')
    expect(readFileSync(path, 'utf-8')).toBe('{ not json')
  })
})
