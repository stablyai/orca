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

  it('requires at least one directory', () => {
    expect(parseSparsePresetDirectories(' \n ')).toEqual({
      directories: [],
      error: 'Add at least one directory.'
    })
  })

  it('rejects root and parent path entries', () => {
    expect(parseSparsePresetDirectories('.')).toEqual({
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    })
    expect(parseSparsePresetDirectories('src/../packages')).toEqual({
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    })
    expect(parseSparsePresetDirectories('/')).toEqual({
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    })
  })

  it.each(['/Users/me/repo/packages/web', 'C:\\repo\\packages\\web', '\\\\server\\share\\repo'])(
    'rejects absolute directory input before normalization: %s',
    (entry) => {
      expect(parseSparsePresetDirectories(entry)).toEqual({
        directories: [],
        error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
      })
    }
  )
})
