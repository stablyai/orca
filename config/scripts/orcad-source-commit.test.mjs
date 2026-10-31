import { describe, expect, it } from 'vitest'
import { resolveOrcadSourceCommit } from './orcad-source-commit.mjs'

describe('orcad source archive provenance', () => {
  it('uses the source checkout unless an archive revision is supplied', () => {
    expect(resolveOrcadSourceCommit({}, () => 'checkout')).toBe('checkout')
    const revision = 'a'.repeat(40)
    expect(
      resolveOrcadSourceCommit({ ORCAD_SOURCE_COMMIT: revision }, () => {
        throw new Error('an archive has no checkout')
      })
    ).toBe(revision)
  })
  it.each(['', 'main', 'a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(40)}\n`])(
    'rejects ambiguous source metadata %j',
    (value) => {
      expect(() => resolveOrcadSourceCommit({ ORCAD_SOURCE_COMMIT: value })).toThrow(
        'ORCAD_SOURCE_COMMIT'
      )
    }
  )
})
