import { describe, expect, it, vi } from 'vitest'
import type { SparsePreset } from '../../shared/worktree/create-types'
import { attributedSparsePresetId } from './sparse-preset-attribution'

const PRESET: SparsePreset = {
  id: 'preset-1',
  repoId: 'repo-1',
  name: 'web',
  directories: ['apps/web', 'packages/ui'],
  createdAt: 0,
  updatedAt: 0
}

describe('the sparse preset a create is recorded under', () => {
  it('keeps a preset whose directories are exactly the ones checked out, in any order', () => {
    expect(
      attributedSparsePresetId(() => [PRESET], 'repo-1', 'preset-1', ['packages/ui', 'apps/web'])
    ).toBe('preset-1')
  })

  it('keeps a preset saved with trailing slashes', () => {
    const preset = { ...PRESET, directories: ['apps/web/', 'packages/ui/'] }
    expect(
      attributedSparsePresetId(() => [preset], 'repo-1', 'preset-1', ['apps/web', 'packages/ui'])
    ).toBe('preset-1')
  })

  it.each([
    ['an edited selection', 'repo-1', 'preset-1', ['apps/web']],
    [
      'a selection that repeats one of its directories',
      'repo-1',
      'preset-1',
      ['apps/web', 'apps/web']
    ],
    ['another repo’s preset', 'repo-2', 'preset-1', ['apps/web', 'packages/ui']],
    ['a preset that no longer exists', 'repo-1', 'preset-gone', ['apps/web', 'packages/ui']]
  ])('records none for %s', (_case, repoId, presetId, directories) => {
    expect(attributedSparsePresetId(() => [PRESET], repoId, presetId, directories)).toBeUndefined()
  })

  it.each([undefined, ''])('does not read presets when no preset was chosen (%j)', (presetId) => {
    const readPresets = vi.fn(() => [PRESET])
    expect(
      attributedSparsePresetId(readPresets, 'repo-1', presetId, ['apps/web', 'packages/ui'])
    ).toBeUndefined()
    expect(readPresets).not.toHaveBeenCalled()
  })

  it('records none, without throwing, when presets cannot be read', () => {
    const readPresets = (): SparsePreset[] => {
      throw new Error('corrupt presets')
    }
    expect(
      attributedSparsePresetId(readPresets, 'repo-1', 'preset-1', ['apps/web', 'packages/ui'])
    ).toBeUndefined()
  })

  it('records none for a preset whose saved directories are not repo-relative', () => {
    const preset = { ...PRESET, directories: ['/abs/apps/web', 'packages/ui'] }
    expect(
      attributedSparsePresetId(() => [preset], 'repo-1', 'preset-1', [
        'abs/apps/web',
        'packages/ui'
      ])
    ).toBeUndefined()
  })
})
