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
    expect(new ClaudeSlashCommandCatalog().commands).toBeUndefined()
    // A frame of the right subtype but without the array is not a catalog.
    expect(
      new ClaudeSlashCommandCatalog({ type: 'system', subtype: 'init' }).commands
    ).toBeUndefined()
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

it('accepts descriptor reloads, removing old skills while retaining terminal filtering', () => {
  const catalog = new ClaudeSlashCommandCatalog(init())
  const reload = {
    type: 'system',
    subtype: 'commands_changed',
    commands: [
      { name: 'clear', description: 'Clear', argumentHint: '' },
      { name: 'new-skill', description: 'New', argumentHint: '' },
      { name: 'doctor', description: 'Terminal', argumentHint: '' }
    ]
  }
  expect(catalog.observe(reload)).toBe(true)
  expect(catalog.commands).toEqual([
    { name: 'clear', kind: 'command', description: 'Clear' },
    { name: 'new-skill', kind: 'skill', description: 'New' }
  ])
  expect(catalog.observe(reload)).toBe(false)
  expect(catalog.observe({ ...reload, commands: [] })).toBe(true)
  expect(catalog.commands).toEqual([])
})

it('lets stream init refine a control seed and preserves kinds across descriptor reloads', () => {
  const seed = { commands: [{ name: 'clear' }, { name: 'project-check' }] }
  const catalog = new ClaudeSlashCommandCatalog(undefined, seed)
  expect(catalog.commands).toEqual([
    { name: 'clear', kind: 'command', kindUnspecified: true },
    { name: 'project-check', kind: 'command', kindUnspecified: true }
  ])
  expect(catalog.observe({ type: 'system', subtype: 'commands_changed', ...seed })).toBe(false)
  const fullInit = init({ slash_commands: ['clear', 'project-check'], skills: ['project-check'] })
  expect(catalog.observe(fullInit)).toBe(true)
  expect(catalog.commands).toEqual([
    { name: 'clear', kind: 'command' },
    { name: 'project-check', kind: 'skill' }
  ])
  expect(catalog.observe({ type: 'system', subtype: 'commands_changed', ...seed })).toBe(false)
  expect(new ClaudeSlashCommandCatalog(fullInit, seed).commands).toEqual(catalog.commands)
  expect(new ClaudeSlashCommandCatalog(init({ slash_commands: [] }), seed).commands).toEqual([])
})

it('distinguishes missing or malformed control catalogs from authoritative empty ones', () => {
  for (const initialization of [undefined, null, {}, { commands: null }, { commands: 'bad' }]) {
    expect(new ClaudeSlashCommandCatalog(undefined, initialization).commands).toBeUndefined()
  }
  expect(new ClaudeSlashCommandCatalog(undefined, { commands: [] }).commands).toEqual([])
  expect(
    new ClaudeSlashCommandCatalog(undefined, {
      commands: [null, {}, { name: ' ' }, { name: 'two words' }, { name: 'ok' }, { name: 'ok' }]
    }).commands
  ).toEqual([{ name: 'ok', kind: 'command', kindUnspecified: true }])
})

it('publishes classification becoming authoritative even when the name and kind stay unchanged', () => {
  const catalog = new ClaudeSlashCommandCatalog(undefined, { commands: [{ name: 'clear' }] })
  expect(catalog.observe(init({ slash_commands: ['clear'], skills: [] }))).toBe(true)
  expect(catalog.commands).toEqual([{ name: 'clear', kind: 'command' }])
})

it('keeps the description and argument hint a descriptor report authored', () => {
  const catalog = new ClaudeSlashCommandCatalog(undefined, {
    commands: [
      { name: 'goal', description: 'Set or view the goal', argumentHint: '<goal>' },
      { name: 'quiet', description: '', argumentHint: '' }
    ]
  })
  expect(catalog.commands).toEqual([
    {
      name: 'goal',
      kind: 'command',
      kindUnspecified: true,
      description: 'Set or view the goal',
      argumentHint: '<goal>'
    },
    { name: 'quiet', kind: 'command', kindUnspecified: true }
  ])
})

it('bounds the row text a provider can put in the picker', () => {
  const catalog = new ClaudeSlashCommandCatalog(undefined, {
    commands: [
      { name: 'long', description: 'x'.repeat(201), argumentHint: 'y'.repeat(101) },
      { name: 'wrong-type', description: 42, argumentHint: { text: 'no' } },
      { name: 'blank', description: '   ' },
      { name: 'wrapped', description: 'first line\n  second   line' }
    ]
  })
  expect(catalog.commands).toEqual([
    { name: 'long', kind: 'command', kindUnspecified: true },
    { name: 'wrong-type', kind: 'command', kindUnspecified: true },
    { name: 'blank', kind: 'command', kindUnspecified: true },
    {
      name: 'wrapped',
      kind: 'command',
      kindUnspecified: true,
      description: 'first line second line'
    }
  ])
})

it('carries descriptor text across the name-only stream init that classifies it', () => {
  const catalog = new ClaudeSlashCommandCatalog(undefined, {
    commands: [
      { name: 'clear', description: 'Clear conversation' },
      { name: 'ref-oss', description: 'A skill' }
    ]
  })
  expect(catalog.observe(init({ slash_commands: ['clear', 'ref-oss'], skills: ['ref-oss'] }))).toBe(
    true
  )
  expect(catalog.commands).toEqual([
    { name: 'clear', kind: 'command', description: 'Clear conversation' },
    { name: 'ref-oss', kind: 'skill', description: 'A skill' }
  ])
})

it('reports a description-only change and lets a later report drop the text', () => {
  const catalog = new ClaudeSlashCommandCatalog(init({ slash_commands: ['clear'], skills: [] }))
  expect(catalog.commands).toEqual([{ name: 'clear', kind: 'command' }])
  const changed = {
    type: 'system',
    subtype: 'commands_changed',
    commands: [{ name: 'clear', description: 'Clear conversation history' }]
  }
  expect(catalog.observe(changed)).toBe(true)
  expect(catalog.commands).toEqual([
    { name: 'clear', kind: 'command', description: 'Clear conversation history' }
  ])
  expect(catalog.observe(changed)).toBe(false)
  expect(catalog.observe({ ...changed, commands: [{ name: 'clear' }] })).toBe(true)
  expect(catalog.commands).toEqual([{ name: 'clear', kind: 'command' }])
})

it('describes nothing when the session reported names only', () => {
  expect(readClaudeSlashCommands(init())).toEqual([
    { name: 'clear', kind: 'command' },
    { name: 'ref-oss', kind: 'skill' },
    { name: 'opsx:apply', kind: 'command' }
  ])
  expect(new ClaudeSlashCommandCatalog(init()).commands).toEqual([
    { name: 'clear', kind: 'command' },
    { name: 'ref-oss', kind: 'skill' },
    { name: 'opsx:apply', kind: 'command' }
  ])
})

it('still hides terminal-only names however well the provider describes them', () => {
  const catalog = new ClaudeSlashCommandCatalog(init())
  expect(
    catalog.observe({
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'doctor', description: 'Diagnose the CLI install' },
        { name: 'ref-oss', description: 'A skill' }
      ]
    })
  ).toBe(true)
  expect(catalog.commands).toEqual([{ name: 'ref-oss', kind: 'skill', description: 'A skill' }])
})
