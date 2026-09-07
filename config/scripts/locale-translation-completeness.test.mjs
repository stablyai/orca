import { describe, expect, it } from 'vitest'
import {
  checkTranslationCompleteness,
  collectTranslationDebt,
  collectTranslationRegressions
} from './locale-translation-completeness.mjs'

describe('translation completeness', () => {
  it('distinguishes real translations, missing entries and copied English', () => {
    expect(
      collectTranslationDebt(
        {
          working: 'Working',
          load: 'Load session',
          empty: 'Empty',
          translated: 'Search',
          brand: 'Codex'
        },
        { working: 'Working', empty: '  ', translated: 'Buscar' }
      )
    ).toEqual({
      working: 'identical: Working',
      load: 'missing: Load session',
      empty: 'missing: Empty'
    })
  })

  it('rejects new debt anywhere and changed source text hidden behind an old exception', () => {
    expect(
      collectTranslationRegressions(
        { old: 'missing: Old', new: 'missing: New', changed: 'identical: Start session' },
        { old: 'missing: Old', changed: 'identical: Load session' }
      ).map(([key]) => key)
    ).toEqual(['new', 'changed'])
  })

  it('requires complete feature references even when their key comes from a different namespace', () => {
    const result = checkTranslationCompleteness({
      english: { external: 'Load session', newFile: 'Empty state', legacy: 'Old' },
      translated: {},
      references: [
        { filePath: 'components/sessions/Card.tsx', key: 'external' },
        { filePath: 'components/sessions/NewEmptyState.tsx', key: 'newFile' }
      ],
      policy: { sourcePrefixes: ['components/sessions/'], keyPrefixes: [], acceptedIdentical: {} },
      baseline: {
        external: 'missing: Load session',
        newFile: 'missing: Empty state',
        legacy: 'missing: Old'
      }
    })
    expect(result.regressions.map(([key]) => key)).toEqual(['external', 'newFile'])
    expect(result.requiredCount).toBe(2)
  })

  it('accepts a reviewed identical term only for its exact key and source value', () => {
    expect(
      collectTranslationDebt(
        { terminal: 'Terminal', other: 'Terminal' },
        { terminal: 'Terminal', other: 'Terminal' },
        { terminal: 'Terminal' }
      )
    ).toEqual({ other: 'identical: Terminal' })
    expect(
      collectTranslationDebt(
        { terminal: 'Load terminal' },
        { terminal: 'Load terminal' },
        { terminal: 'Terminal' }
      )
    ).toEqual({ terminal: 'identical: Load terminal' })
  })
})
