import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => void store.set(key, value)
  }
}))

import {
  cloudRepoChoices,
  cloudRepoSlug,
  loadRecentCloudRepos,
  recordRecentCloudRepo
} from './cloud-recent-repos'

describe('repository picker choices', () => {
  beforeEach(() => store.clear())

  it('reads owner/repo from GitHub URLs and slugs, nothing else', () => {
    expect(cloudRepoSlug('https://github.com/octocat/Hello-World')).toBe('octocat/Hello-World')
    expect(cloudRepoSlug('https://github.com/acme/app.git')).toBe('acme/app')
    expect(cloudRepoSlug('acme/app')).toBe('acme/app')
    expect(cloudRepoSlug('https://gitlab.com/acme/app')).toBeNull()
  })

  it('lists this phone’s recents first, then the team’s projects, each once', async () => {
    await recordRecentCloudRepo('https://github.com/acme/app')
    await recordRecentCloudRepo('https://github.com/acme/web')
    await recordRecentCloudRepo('https://github.com/acme/app')
    expect(await loadRecentCloudRepos()).toEqual(['acme/app', 'acme/web'])
    expect(
      cloudRepoChoices(await loadRecentCloudRepos(), [
        'https://github.com/acme/web',
        'https://github.com/octocat/Hello-World'
      ])
    ).toEqual(['acme/app', 'acme/web', 'octocat/Hello-World'])
  })
})
