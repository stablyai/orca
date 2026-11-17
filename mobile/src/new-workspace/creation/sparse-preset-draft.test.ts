import { describe, expect, it } from 'vitest'
import { parseSparsePresetDirectories } from './sparse-preset-draft'

describe('parseSparsePresetDirectories', () => {
  it('normalizes textarea input into unique repo-relative directories', () => {
    expect(
      parseSparsePresetDirectories(`
        src\\renderer
        packages/ui/
        src/renderer
      `)
    ).toEqual({
      directories: ['src/renderer', 'packages/ui'],
      error: null
    })
  })
})
