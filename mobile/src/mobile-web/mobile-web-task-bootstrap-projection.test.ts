import { expect, it } from 'vitest'
import type { HostTaskBootstrap } from '../tasks/host-task-read-operations'
import { mobileWebTaskSettings } from './mobile-web-task-bootstrap-projection'

it('falls back from Jira-only host settings and maps repository IDs opaquely', () => {
  const settings = {
    defaultTaskSource: 'jira',
    visibleTaskProviders: ['jira'],
    defaultRepoSelection: ['host-visible', 'host-missing']
  } satisfies HostTaskBootstrap['settings']

  expect(
    mobileWebTaskSettings(settings, (hostRepoId) =>
      hostRepoId === 'host-visible' ? 'repo_opaque' : null
    )
  ).toMatchObject({
    defaultTaskSource: 'github',
    visibleTaskProviders: ['github', 'gitlab', 'linear'],
    defaultRepoSelection: ['repo_opaque']
  })
})

it('preserves null repository selection and chooses a visible hosted provider', () => {
  const settings = {
    defaultTaskSource: 'jira',
    visibleTaskProviders: ['linear', 'jira'],
    defaultRepoSelection: null
  } satisfies HostTaskBootstrap['settings']

  expect(mobileWebTaskSettings(settings, () => 'unused')).toMatchObject({
    defaultTaskSource: 'linear',
    visibleTaskProviders: ['linear'],
    defaultRepoSelection: null
  })
})
