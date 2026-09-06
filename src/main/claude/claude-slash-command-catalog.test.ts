import { describe, expect, it } from 'vitest'
import { ClaudeSlashCommandCatalog, readClaudeSlashCommands } from './claude-slash-command-catalog'

function init(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'provider-1',
    slash_commands: ['clear', 'ref-oss', 'doctor', 'opsx:apply'],
    terminal_slash_commands: ['doctor'],
    skills: ['ref-oss', 'doctor'],
    ...overrides
  }
}

describe('claude slash command catalog', () => {
  it('tags reported skills and drops the commands reserved for a terminal UI', () => {
    expect(readClaudeSlashCommands(init())).toEqual([
      { name: 'clear', kind: 'command' },
      { name: 'ref-oss', kind: 'skill' },
      { name: 'opsx:apply', kind: 'command' }
    ])
  })

  it('rejects blank, whitespace-carrying and duplicate names', () => {
    expect(
      readClaudeSlashCommands(
        init({ slash_commands: ['clear', '  ', 'two words', 'clear'], skills: [] })
      )
    ).toEqual([{ name: 'clear', kind: 'command' }])
  })

  it('seeds from the init frame that proved the session', () => {
    expect(new ClaudeSlashCommandCatalog(init()).commands).toHaveLength(3)
    expect(new ClaudeSlashCommandCatalog().commands).toEqual([])
    // A frame of the right subtype but without the array is not a catalog.
    expect(new ClaudeSlashCommandCatalog({ type: 'system', subtype: 'init' }).commands).toEqual([])
  })

  it('replaces the catalog on commands_changed and reports only real changes', () => {
    const catalog = new ClaudeSlashCommandCatalog(init())
    expect(catalog.observe(init())).toBe(false)
    expect(catalog.observe({ type: 'assistant', slash_commands: ['other'] })).toBe(false)
    expect(
      catalog.observe({
        type: 'system',
        subtype: 'commands_changed',
        slash_commands: ['clear', 'brand-new'],
        skills: ['brand-new']
      })
    ).toBe(true)
    expect(catalog.commands).toEqual([
      { name: 'clear', kind: 'command' },
      { name: 'brand-new', kind: 'skill' }
    ])
  })

  it('notices a name that only changed kind', () => {
    const catalog = new ClaudeSlashCommandCatalog(
      init({ slash_commands: ['review'], skills: [], terminal_slash_commands: [] })
    )
    expect(
      catalog.observe({
        type: 'system',
        subtype: 'commands_changed',
        slash_commands: ['review'],
        skills: ['review']
      })
    ).toBe(true)
    expect(catalog.commands).toEqual([{ name: 'review', kind: 'skill' }])
  })
})
