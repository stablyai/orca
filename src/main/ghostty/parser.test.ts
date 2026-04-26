import { describe, expect, it } from 'vitest'
import { parseGhosttyConfig } from './parser'

describe('parseGhosttyConfig', () => {
  it('returns empty object for empty content', () => {
    expect(parseGhosttyConfig('')).toEqual({})
  })

  it('parses a single key-value pair', () => {
    expect(parseGhosttyConfig('font-family = JetBrains Mono')).toEqual({
      'font-family': 'JetBrains Mono'
    })
  })

  it('ignores comments and blank lines', () => {
    const input = `
# This is a comment
font-size = 14

background = #1a1a1a
`
    expect(parseGhosttyConfig(input)).toEqual({
      'font-size': '14',
      background: '#1a1a1a'
    })
  })

  it('ignores lines without an equals sign', () => {
    expect(parseGhosttyConfig('invalid line\nfont-family = Fira Code')).toEqual({
      'font-family': 'Fira Code'
    })
  })

  it('trims whitespace around keys and values', () => {
    expect(parseGhosttyConfig('  foreground   =   #ffffff  ')).toEqual({
      foreground: '#ffffff'
    })
  })

  it('parses multiple entries', () => {
    const input = `
font-family = JetBrains Mono
font-size = 13
cursor-style = bar
`
    expect(parseGhosttyConfig(input)).toEqual({
      'font-family': 'JetBrains Mono',
      'font-size': '13',
      'cursor-style': 'bar'
    })
  })

  it('returns array for duplicate keys', () => {
    const input = `
palette = 0=#000000
palette = 1=#ff0000
palette = 2=#00ff00
`
    const result = parseGhosttyConfig(input)
    expect(result.palette).toEqual(['0=#000000', '1=#ff0000', '2=#00ff00'])
  })

  it('keeps single value as string when key is not duplicated', () => {
    const input = `
font-family = JetBrains Mono
palette = 0=#000000
`
    const result = parseGhosttyConfig(input)
    expect(result['font-family']).toBe('JetBrains Mono')
    expect(result.palette).toBe('0=#000000')
  })

  it('strips inline comments', () => {
    const input = `
font-size = 14 # this is the size
background = #1a1a1a # dark theme
`
    const result = parseGhosttyConfig(input)
    expect(result['font-size']).toBe('14')
    expect(result.background).toBe('#1a1a1a')
  })

  it('preserves # inside quoted values', () => {
    const input = `
palette = 0="#000000" # black
`
    const result = parseGhosttyConfig(input)
    expect(result.palette).toBe('0="#000000"')
  })

  it('preserves # inside single-quoted values', () => {
    const input = `
palette = 0='#000000' # black
`
    const result = parseGhosttyConfig(input)
    expect(result.palette).toBe("0='#000000'")
  })

  it('strips surrounding double quotes from string values', () => {
    const result = parseGhosttyConfig('font-family = "JetBrains Mono"')
    expect(result['font-family']).toBe('JetBrains Mono')
  })

  it('strips surrounding single quotes from string values', () => {
    const result = parseGhosttyConfig("font-family = 'JetBrains Mono'")
    expect(result['font-family']).toBe('JetBrains Mono')
  })
})
