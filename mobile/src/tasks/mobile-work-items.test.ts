import { afterEach, describe, expect, it } from 'vitest'
import { mobileI18n } from '../i18n/mobile-i18n'
import { isGitHubWorkItemsSshRemoteRequiredError } from './mobile-work-items'

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

describe('mobile work-item errors', () => {
  it('matches the provider sentinel independently of the UI locale', async () => {
    await mobileI18n.changeLanguage('es')

    expect(
      isGitHubWorkItemsSshRemoteRequiredError(
        new Error('GitHub work items require a GitHub remote for SSH repositories')
      )
    ).toBe(true)
  })
})
