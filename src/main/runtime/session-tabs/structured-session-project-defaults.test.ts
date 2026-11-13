import { expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import { structuredSessionProjectSeedOptions } from './structured-session-project-defaults'

it('seeds chats from the owning host project while unrelated workspaces inherit global settings', () => {
  const settings = {
    ...getDefaultSettings('/home/test'),
    agentLaunchChoices: { codex: { model: 'global-model', options: { effort: 'low' } } }
  }
  const base: Repo = {
    id: 'same',
    path: '/local',
    displayName: 'Project',
    badgeColor: '',
    addedAt: 1
  }
  const repos: Repo[] = [
    { ...base, agentLaunchDefaults: { agentLaunchChoices: { codex: { model: 'local-model' } } } },
    {
      ...base,
      path: '/remote',
      executionHostId: 'ssh:server',
      agentLaunchDefaults: {
        agentLaunchChoices: { codex: { model: 'remote-model', options: { effort: 'high' } } }
      }
    }
  ]
  const store = { getSettings: () => settings, getRepos: () => repos }
  expect(
    structuredSessionProjectSeedOptions(store, 'codex', { repoId: 'same', hostId: 'ssh:server' })
  ).toMatchObject({ model: 'remote-model', effort: 'high' })
  expect(
    structuredSessionProjectSeedOptions(store, 'codex', { repoId: 'same', hostId: 'local' })?.model
  ).toBe('local-model')
  expect(
    structuredSessionProjectSeedOptions(store, 'codex', { repoId: 'unknown', hostId: 'local' })
  ).toMatchObject({ model: 'global-model', effort: 'low' })
})
