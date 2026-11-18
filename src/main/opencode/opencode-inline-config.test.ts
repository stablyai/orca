import { describe, expect, it } from 'vitest'
import { readOpenCodeInlineConfig, withOpenCodeInstructionsFile } from './opencode-inline-config'

describe('withOpenCodeInstructionsFile', () => {
  it('adds the file to an empty or absent configuration', () => {
    for (const content of [undefined, '', '  ']) {
      expect(JSON.parse(withOpenCodeInstructionsFile(content, '/bot.md')!)).toEqual({
        instructions: ['/bot.md']
      })
    }
  })

  it("keeps the user's settings and their own instructions ahead of the file", () => {
    const content = JSON.stringify({ model: 'x/y', instructions: ['/mine.md'] })
    expect(JSON.parse(withOpenCodeInstructionsFile(content, '/bot.md')!)).toEqual({
      model: 'x/y',
      instructions: ['/mine.md', '/bot.md']
    })
  })

  it('refuses content a rewrite would lose', () => {
    for (const content of ['{ // jsonc\n}', '[]', '"text"', '{"instructions":"/one.md"}']) {
      expect(withOpenCodeInstructionsFile(content, '/bot.md')).toBeNull()
    }
  })
})

describe('readOpenCodeInlineConfig', () => {
  it('reads only plain JSON objects', () => {
    expect(readOpenCodeInlineConfig('{"a":1}')).toEqual({ a: 1 })
    expect(readOpenCodeInlineConfig('null')).toBeNull()
    expect(readOpenCodeInlineConfig('{')).toBeNull()
  })
})
