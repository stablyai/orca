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
})
