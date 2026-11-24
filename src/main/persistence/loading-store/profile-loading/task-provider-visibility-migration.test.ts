import { expect, it } from 'vitest'
import { migrateLoadedTaskProviderSettings } from './task-provider-visibility-migration'

it('shows ClickUp once and leaves the other providers alone', () => {
  const result = migrateLoadedTaskProviderSettings({
    visibleTaskProviders: ['github', 'linear', 'jira'],
    defaultTaskSource: 'linear',
    visibleTaskProvidersDefaultedForJira: true
  })

  expect(result.taskProviderSettings).toEqual({
    visibleTaskProviders: ['github', 'linear', 'jira', 'clickup'],
    defaultTaskSource: 'linear'
  })
  expect(result.needsSave).toBe(true)
})

it('does not re-add a provider the user hid after it was shown once', () => {
  const result = migrateLoadedTaskProviderSettings({
    visibleTaskProviders: ['github', 'linear'],
    defaultTaskSource: 'github',
    visibleTaskProvidersDefaultedForJira: true,
    visibleTaskProvidersDefaultedForClickUp: true
  })

  expect(result.taskProviderSettings.visibleTaskProviders).toEqual(['github', 'linear'])
  expect(result.needsSave).toBe(false)
})
