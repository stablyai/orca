import { afterEach, describe, expect, it } from 'vitest'
import { mobileI18n } from '../i18n/mobile-i18n'
import { getWorkspaceSortOptions } from './workspace-list-picker-options'

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

describe('WORKSPACE_SORT_OPTIONS', () => {
  it('keeps the persisted sort values stable for desktop compatibility', () => {
    expect(getWorkspaceSortOptions().map((option) => option.value)).toEqual([
      'smart',
      'name',
      'recent',
      'repo',
      'manual'
    ])
  })

  it('keeps the smart sort value while showing the agent activity label', () => {
    expect(getWorkspaceSortOptions().find((option) => option.value === 'smart')).toEqual({
      value: 'smart',
      label: 'Agent activity',
      subtitle: 'Agents that need attention, then recent activity'
    })
  })

  it('reads labels from the active locale when options are requested', async () => {
    await mobileI18n.changeLanguage('es')
    expect(getWorkspaceSortOptions().find((option) => option.value === 'name')?.label).toBe(
      'Nombre'
    )

    await mobileI18n.changeLanguage('ja')
    expect(getWorkspaceSortOptions().find((option) => option.value === 'name')?.label).toBe('名前')
  })
})
