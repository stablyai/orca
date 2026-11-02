import { describe, expect, it } from 'vitest'
import { parseGhosttyConfig } from './parser'

describe('parseGhosttyConfig', () => {
  it('returns array for duplicate keys', () => {
    const input = `
palette = 0=#000000
palette = 1=#ff0000
palette = 2=#00ff00
`
    const result = parseGhosttyConfig(input)
    expect(result.palette).toEqual(['0=#000000', '1=#ff0000', '2=#00ff00'])
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
})
