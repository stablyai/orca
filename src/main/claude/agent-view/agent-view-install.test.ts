import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { claudeAgentViewChord } from './agent-view-keybindings'
import {
  installClaudeAgentView,
  refreshClaudeAgentView,
  removeClaudeAgentView
} from './agent-view-install'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('preserves JSONC comments and trailing commas through install and removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const path = join(root, 'keybindings.json')
  const original = `{
    // My keybindings
    "bindings": [{ "context": "Chat", "bindings": {
      // This user binding must survive
      "Alt+Control+G": "command:user-command",
    } }],
  }`
  writeFileSync(path, original)
  installClaudeAgentView(join(root, 'settings.json'))
  const installed = readFileSync(path, 'utf8')
  expect(installed).toContain('// My keybindings')
  expect(installed).toContain('// This user binding must survive')
  expect(claudeAgentViewChord(installed)).toBe('ctrl+alt+h')
  installClaudeAgentView(join(root, 'settings.json'))
  expect(readFileSync(path, 'utf8')).toBe(installed)
  removeClaudeAgentView(join(root, 'settings.json'))
  const removed = readFileSync(path, 'utf8')
  expect(removed).toContain('// This user binding must survive')
  expect(parse(removed).bindings[0].bindings['Alt+Control+G']).toBe('command:user-command')
  expect(claudeAgentViewChord(removed)).toBeUndefined()
})

it('never overwrites an unowned skill and removes only its own installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const folder = join(root, 'skills', 'orca-agent-view')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), 'user-owned')
  installClaudeAgentView(join(root, 'settings.json'))
  removeClaudeAgentView(join(root, 'settings.json'))
  expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toBe('user-owned')
  rmSync(folder, { recursive: true })
  writeFileSync(
    join(root, 'keybindings.json'),
    JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+a': 'user:action' } }] })
  )
  installClaudeAgentView(join(root, 'settings.json'))
  removeClaudeAgentView(join(root, 'settings.json'))
  expect(JSON.parse(readFileSync(join(root, 'keybindings.json'), 'utf8')).bindings).toEqual([
    { context: 'Chat', bindings: { 'ctrl+a': 'user:action' } }
  ])
})

it('removes only its recorded binding across reinstalls, preserving other contexts and chords', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const settings = join(root, 'settings.json')
  const path = join(root, 'keybindings.json')
  installClaudeAgentView(settings)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const userBindings = [
    { context: 'Global', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } },
    { context: 'Chat', bindings: { 'ctrl+x': 'command:orca-agent-view' } }
  ]
  config.bindings.push(...userBindings)
  writeFileSync(path, JSON.stringify(config))
  installClaudeAgentView(settings)
  removeClaudeAgentView(settings)
  expect(JSON.parse(readFileSync(path, 'utf8')).bindings).toEqual([...userBindings])
})

it('remembers removed and edited bindings across launches', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const settings = join(root, 'settings.json')
  const bindings = join(root, 'keybindings.json')
  expect(installClaudeAgentView(settings)).toBe(true)
  writeFileSync(bindings, '{"bindings": []}')
  expect(installClaudeAgentView(settings)).toBe(false)
  expect(readFileSync(bindings, 'utf8')).toBe('{"bindings": []}')
  writeFileSync(
    bindings,
    '{"bindings": [{"context":"Chat","bindings":{"ctrl+x":"command:orca-agent-view"}}]}'
  )
  expect(installClaudeAgentView(settings)).toBe(false)
  expect(claudeAgentViewChord(readFileSync(bindings, 'utf8'))).toBeUndefined()
})

it.each([false, true])(
  'retires the legacy auto-loaded mod while preserving opt-out memory (malformed: %s)',
  async (malformed) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
    roots.push(root)
    const legacy = join(root, 'skills', 'orca-agent-view')
    mkdirSync(join(legacy, '.claude-plugin'), { recursive: true })
    mkdirSync(join(legacy, 'hooks'))
    writeFileSync(
      join(legacy, '.claude-plugin', 'orca-managed.json'),
      JSON.stringify({
        owner: 'stablyai/orca/claude-agent-view',
        binding: { context: 'Chat', chord: 'ctrl+alt+g' }
      })
    )
    writeFileSync(join(legacy, 'hooks', 'register.js'), 'legacy')
    const bindings = join(root, 'keybindings.json')
    writeFileSync(
      bindings,
      malformed
        ? '{broken'
        : '{"bindings":[{"context":"Chat","bindings":{"ctrl+alt+g":"command:orca-agent-view"}}]}'
    )
    await refreshClaudeAgentView(join(root, 'settings.json'))
    expect(existsSync(join(legacy, 'hooks', 'register.js'))).toBe(false)
    if (malformed) {
      expect(readFileSync(bindings, 'utf8')).toBe('{broken')
      writeFileSync(
        bindings,
        '{"bindings":[{"context":"Chat","bindings":{"ctrl+alt+g":"command:orca-agent-view"}}]}'
      )
      await refreshClaudeAgentView(join(root, 'settings.json'))
    }
    expect(existsSync(legacy)).toBe(false)
    expect(JSON.parse(readFileSync(bindings, 'utf8')).bindings).toEqual([])
    expect(installClaudeAgentView(join(root, 'settings.json'))).toBe(true)
  }
)
