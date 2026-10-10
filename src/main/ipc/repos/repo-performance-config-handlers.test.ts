import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'

const { handlers, runMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  runMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../../git/repo-performance-config', () => ({
  runRepoPerformanceConfig: runMock
}))

import { registerRepoPerformanceConfigHandlers } from './repo-performance-config-handlers'

function createStore(settings: Partial<GlobalSettings>, repos: Repo[]) {
  return {
    store: {
      getSettings: () => settings,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    }
  }
}

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'git'
}

function register(settings: Partial<GlobalSettings>) {
  const fixture = createStore(settings, [repo])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the store methods this fixture implements.
  registerRepoPerformanceConfigHandlers(fixture.store as never)
  const invoke = (args: unknown) => handlers.get('repos:performanceConfig')?.({}, args)
  return { ...fixture, invoke }
}

describe('repos:performanceConfig', () => {
  beforeEach(() => {
    handlers.clear()
    runMock.mockReset().mockResolvedValue({ status: 'ok', state: { orcaKeys: [], userKeys: [] } })
  })

  it('refuses to apply while the setting is off, but still inspects and reverts', async () => {
    const { invoke } = register({ gitTuning: 'off' })

    await expect(invoke({ repoId: 'repo-1', action: 'apply' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'disabled'
    })
    await invoke({ repoId: 'repo-1', action: 'inspect' })
    await invoke({ repoId: 'repo-1', action: 'revert' })
    expect(runMock.mock.calls.map((call) => call[1])).toEqual(['inspect', 'revert'])
  })

  it('applies when the user chose Recommended, with the file watcher only if opted in', async () => {
    await register({ gitTuning: 'recommended' }).invoke({ repoId: 'repo-1', action: 'apply' })
    await register({ gitTuning: 'recommended', gitTuningFsmonitor: true }).invoke({
      repoId: 'repo-1',
      action: 'apply'
    })
    expect(runMock.mock.calls).toEqual([
      [repo, 'apply', { fsmonitor: false }],
      [repo, 'apply', { fsmonitor: true }]
    ])
  })

  it('rejects malformed arguments and unknown repositories', async () => {
    const { invoke } = register({ gitTuning: 'recommended' })
    await expect(invoke({ repoId: 'repo-1', action: 'exec' })).rejects.toThrow()
    await expect(invoke({ repoId: 'missing', action: 'inspect' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-found'
    })
  })
})
