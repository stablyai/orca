import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

const repairEs = (enValue, localeValue) =>
  repairTranslatedValue({
    key: 'auto.components.test.pr-glossary',
    enValue,
    localeValue,
    locale: 'es'
  })

describe('locale-translation-policy es PR glossary', () => {
  it('rewrites the "relaciones públicas" mistranslation of PR back to PR', () => {
    expect(repairEs('PR', 'relaciones públicas')).toBe('PR')
    expect(repairEs('PRs', 'relaciones públicas')).toBe('PR')
    expect(repairEs('Reopen PR', 'Reabrir relaciones públicas')).toBe('Reabrir PR')
    expect(repairEs('Create PR', 'Crear relaciones públicas')).toBe('Crear PR')
    expect(repairEs('Open PR checks', 'Abrir cheques de relaciones públicas')).toBe(
      'Abrir cheques de PR'
    )
    expect(repairEs('unlink PR', 'desvincular relaciones públicas')).toBe('desvincular PR')
  })

  it('rewrites PR inside longer sentences', () => {
    expect(
      repairEs(
        'Add Orca attribution to commits, PRs, and issues.',
        'Agregue la atribución de Orca a commits, relaciones públicas y problemas.'
      )
    ).toBe('Agregue la atribución de Orca a commits, PR y problemas.')
    expect(
      repairEs(
        'Open the PR details to view current reviewers.',
        'Abra los detalles de relaciones públicas para ver los revisores actuales.'
      )
    ).toBe('Abra los detalles de PR para ver los revisores actuales.')
  })

  it('leaves an already correct PR translation untouched', () => {
    expect(repairEs('Reopen PR', 'Reabrir PR')).toBe('Reabrir PR')
  })

  it('does not fire when the English has a "pr" substring but no PR token', () => {
    // "approve"/"public" contain the substring "pr" but not the PR token, so a genuine
    // "public relations" string must be left alone.
    expect(repairEs('Approve public relations', 'Aprobar relaciones públicas')).toBe(
      'Aprobar relaciones públicas'
    )
    expect(repairEs('Compress the preview', 'Comprimir las relaciones públicas')).toBe(
      'Comprimir las relaciones públicas'
    )
  })
})
