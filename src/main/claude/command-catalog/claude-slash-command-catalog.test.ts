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
