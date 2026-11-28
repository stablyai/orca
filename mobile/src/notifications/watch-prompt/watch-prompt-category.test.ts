import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WATCH_PROMPT_CATEGORY } from '../../../../src/shared/notifications/watch-prompt-reply'

const setNotificationCategoryAsync = vi.hoisted(() => vi.fn(async () => undefined))
const platform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('react-native', () => ({ Platform: platform }))
vi.mock('expo-notifications', () => ({ setNotificationCategoryAsync }))

import { registerWatchPromptCategory } from './watch-prompt-category'

beforeEach(() => {
  setNotificationCategoryAsync.mockClear()
  platform.OS = 'ios'
})

describe('registerWatchPromptCategory', () => {
  it('registers Allow and Deny on the category Apple Watch mirrors', async () => {
    await registerWatchPromptCategory()
    expect(setNotificationCategoryAsync).toHaveBeenCalledWith(WATCH_PROMPT_CATEGORY, [
      {
        identifier: 'allow',
        buttonTitle: 'Allow',
        options: { opensAppToForeground: false, isAuthenticationRequired: true }
      },
      {
        identifier: 'deny',
        buttonTitle: 'Deny',
        options: {
          opensAppToForeground: false,
          isDestructive: true,
          isAuthenticationRequired: true
        }
      }
    ])
  })

  it('skips registration off iOS', async () => {
    platform.OS = 'android'
    await registerWatchPromptCategory()
    expect(setNotificationCategoryAsync).not.toHaveBeenCalled()
  })
})
