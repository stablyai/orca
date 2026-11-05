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

  it('does not fire when the English has a "pr" substring but no PR token', () => {
    // approve/public contain pr substring but no PR token; leave genuine public-relations prose alone.
    expect(repairEs('Approve public relations', 'Aprobar relaciones públicas')).toBe(
      'Aprobar relaciones públicas'
    )
    expect(repairEs('Compress the preview', 'Comprimir las relaciones públicas')).toBe(
      'Comprimir las relaciones públicas'
    )
  })
})
