import { afterEach, describe, expect, it } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import type { MultiRepoMemberState } from '../../../src/shared/multi-repo-workspace'
import { multiRepoChipText } from './multi-repo-workspace-summary'

const members = (...states: MultiRepoMemberState[]) => states.map((state) => ({ state }))

afterEach(async () => {
  await activateMobileUiLocale('en')
})

describe('multi-repo chip text', () => {
  it('counts repos and problem states with plural-aware words', () => {
    expect(multiRepoChipText(members('ready'))).toBe('1 repo')
    expect(multiRepoChipText(members('ready', 'failed', 'interrupted'))).toBe(
      '3 repos · 1 failed · 1 interrupted'
    )
    expect(multiRepoChipText(members('ready', 'creating', 'queued'))).toBe('Creating 1/3')
  })

  it('uses the active locale plural forms', async () => {
    await activateMobileUiLocale('ru')
    expect(multiRepoChipText(members('ready'))).toBe('1 репозиторий')
    expect(multiRepoChipText(members('ready', 'ready'))).toBe('2 репозитория')
    expect(multiRepoChipText(members('ready', 'ready', 'ready', 'ready', 'ready'))).toBe(
      '5 репозиториев'
    )
  })
})
