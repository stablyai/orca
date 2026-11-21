import { describe, expect, it } from 'vitest'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'

function catalogOf(count: number, description: string, namePrefix = 'demo', argumentHint?: string) {
  return new ClaudeSlashCommandCatalog(undefined, {
    commands: Array.from({ length: count }, (_, index) => ({
      name: `${namePrefix}-${String(index).padStart(4, '0')}`,
      description,
      argumentHint
    }))
  }).commands
}

describe('Claude slash command catalog size', () => {
  it('keeps every entry of a catalog past 512 entries', () => {
    const commands = catalogOf(600, 'Synthetic entry')
    expect(commands).toHaveLength(600)
    expect(commands?.at(-1)).toMatchObject({ name: 'demo-0599', description: 'Synthetic entry' })
  })

  it('keeps every name of a stream init past 512 names', () => {
    const catalog = new ClaudeSlashCommandCatalog()
    const names = Array.from(
      { length: 600 },
      (_, index) => `demo-${String(index).padStart(4, '0')}`
    )
    expect(
      catalog.observe({
        type: 'system',
        subtype: 'init',
        slash_commands: names,
        skills: names.slice(300)
      })
    ).toBe(true)
    expect(catalog.commands).toHaveLength(600)
    expect(catalog.commands?.at(-1)).toEqual({ name: 'demo-0599', kind: 'skill' })
  })

  it('stops at the serialized size a remote frame has room for', () => {
    const commands = catalogOf(4000, '\u8aac'.repeat(200)) ?? []
    expect(commands.length).toBeGreaterThan(600)
    expect(commands.length).toBeLessThan(1024)
    expect(Buffer.byteLength(JSON.stringify(commands), 'utf8')).toBeLessThanOrEqual(512 * 1024)
    expect(commands.at(-1)?.name).toBe(`demo-${String(commands.length - 1).padStart(4, '0')}`)
  })

  it('keeps the first 512 rows even when long CJK rows pass the size bound', () => {
    const commands =
      catalogOf(600, '\u8aac'.repeat(200), '\u8aac'.repeat(190), '\u8aac'.repeat(100)) ?? []
    expect(Buffer.byteLength(JSON.stringify(commands.slice(0, 512)), 'utf8')).toBeGreaterThan(
      512 * 1024
    )
    expect(commands).toHaveLength(512)
    expect(commands.at(-1)?.name).toBe(`${'\u8aac'.repeat(190)}-0511`)
  })
})

describe('Claude account skill names', () => {
  it('keeps the name initialize reports after stream init namespaces a claude.ai skill', () => {
    const catalog = new ClaudeSlashCommandCatalog(undefined, {
      commands: [
        { name: 'deep-research', description: 'Built-in research', builtin: true },
        { name: 'anthropic-skills:deep-research', description: 'Account research' },
        { name: 'pro-mode', argumentHint: '<task>' }
      ]
    })
    catalog.observe({
      type: 'system',
      subtype: 'init',
      slash_commands: [
        'deep-research',
        'anthropic-skills:deep-research',
        'anthropic-skills:pro-mode'
      ],
      skills: ['anthropic-skills:deep-research', 'anthropic-skills:pro-mode']
    })
    expect(catalog.commands).toEqual([
      { name: 'deep-research', kind: 'command', description: 'Built-in research', builtin: true },
      { name: 'anthropic-skills:deep-research', kind: 'skill', description: 'Account research' },
      { name: 'pro-mode', kind: 'skill', argumentHint: '<task>' }
    ])
  })
})

describe('Claude account skill names beside other namespaces', () => {
  it('does not add a second row when the stream also reports the bare name', () => {
    const catalog = new ClaudeSlashCommandCatalog(undefined, {
      commands: [{ name: 'pdf', description: 'Account PDF' }]
    })
    catalog.observe({
      type: 'system',
      subtype: 'init',
      slash_commands: ['pdf', 'anthropic-skills:pdf'],
      skills: ['pdf', 'anthropic-skills:pdf']
    })
    expect(catalog.commands).toEqual([
      { name: 'pdf', kind: 'skill', description: 'Account PDF' },
      { name: 'anthropic-skills:pdf', kind: 'skill' }
    ])
  })

  it('restores an account skill whose bare name a plugin skill also uses', () => {
    const catalog = new ClaudeSlashCommandCatalog(undefined, {
      commands: [
        { name: 'document-skills:pdf', description: 'Plugin PDF' },
        { name: 'pdf', description: 'Account PDF', argumentHint: '<file>' }
      ]
    })
    catalog.observe({
      type: 'system',
      subtype: 'init',
      slash_commands: ['document-skills:pdf', 'anthropic-skills:pdf'],
      skills: ['document-skills:pdf', 'anthropic-skills:pdf']
    })
    expect(catalog.commands).toEqual([
      { name: 'document-skills:pdf', kind: 'skill', description: 'Plugin PDF' },
      { name: 'pdf', kind: 'skill', description: 'Account PDF', argumentHint: '<file>' }
    ])
  })
})

describe('Claude account skill names across catalog updates', () => {
  it('applies descriptors that arrive after the stream catalog', () => {
    const catalog = new ClaudeSlashCommandCatalog()
    catalog.observe({
      type: 'system',
      subtype: 'init',
      slash_commands: ['anthropic-skills:pro-mode'],
      skills: ['anthropic-skills:pro-mode']
    })
    catalog.adoptInitialization({ commands: [{ name: 'pro-mode', argumentHint: '<task>' }] })
    expect(catalog.commands).toEqual([{ name: 'pro-mode', kind: 'skill', argumentHint: '<task>' }])
  })

  it('keeps newer descriptors when a late initialize arrives', () => {
    const catalog = new ClaudeSlashCommandCatalog()
    catalog.observe({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'pdf', description: 'Current' }]
    })
    catalog.observe({
      type: 'system',
      subtype: 'init',
      slash_commands: ['anthropic-skills:pdf'],
      skills: ['anthropic-skills:pdf']
    })
    catalog.adoptInitialization({ commands: [{ name: 'pdf', description: 'Stale' }] })
    expect(catalog.commands).toEqual([{ name: 'pdf', kind: 'skill', description: 'Current' }])
  })

  it('keeps the namespaced spelling when descriptors list it too', () => {
    const catalog = new ClaudeSlashCommandCatalog(undefined, {
      commands: [{ name: 'anthropic-skills:pdf', description: 'Account PDF' }, { name: 'pdf' }]
    })
    catalog.observe({
      type: 'system',
      subtype: 'init',
      slash_commands: ['anthropic-skills:pdf'],
      skills: ['anthropic-skills:pdf']
    })
    expect(catalog.commands).toEqual([
      { name: 'anthropic-skills:pdf', kind: 'skill', description: 'Account PDF' }
    ])
  })

  it('keeps the launch folder kind after a cd drops the account skill from skills', () => {
    const catalog = new ClaudeSlashCommandCatalog(undefined, {
      commands: [{ name: 'pro-mode', argumentHint: '<task>' }]
    })
    catalog.observe({
      type: 'system',
      subtype: 'init',
      cwd: '/launch',
      slash_commands: ['anthropic-skills:pro-mode'],
      skills: ['anthropic-skills:pro-mode']
    })
    catalog.observe({
      type: 'system',
      subtype: 'commands_changed',
      cwd: '/elsewhere',
      slash_commands: ['anthropic-skills:pro-mode'],
      skills: []
    })
    expect(catalog.commands).toEqual([{ name: 'pro-mode', kind: 'skill', argumentHint: '<task>' }])
  })
})
