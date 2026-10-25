import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as GhUtils from '../../src/main/github/gh-utils'
import type * as ReactModule from 'react'
import type { GitHubOwnerRepo } from '../../src/shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'
import type { GitHubIssueUpdate } from '../../src/shared/issue-mutation-types'

const fixture = vi.hoisted(() => {
  const state: {
    callbacks: unknown[]
    mutation: Promise<unknown> | null
    gh: ReturnType<typeof vi.fn>
    apiUpdate: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
    preference: 'origin' | 'upstream'
    localGitOptions: { wslDistro?: string }
    requests: { args: string[]; host?: string; cwd?: string; wslDistro?: string }[]
  } = {
    callbacks: [],
    mutation: null,
    gh: vi.fn(),
    apiUpdate: vi.fn(),
    patch: vi.fn(),
    preference: 'origin',
    localGitOptions: {},
    requests: []
  }
  return state
})

vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
  useMemo: <T>(getValue: () => T) => getValue(),
  useCallback: <T>(callback: T) => {
    fixture.callbacks.push(callback)
    return callback
  }
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        patchWorkItem: fixture.patch,
        patchProjectRowContent: fixture.patch,
        repos: [],
        settings: {}
      }),
    { getState: () => ({ recordFeatureInteraction: vi.fn() }) }
  )
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: vi.fn(),
  PopoverContent: vi.fn(),
  PopoverTrigger: vi.fn()
}))
vi.mock('@/hooks/useIssueMetadata', () => ({
  useRepoAssignees: () => ({ data: [], loading: false, error: null }),
  useImmediateMutation: () => ({
    isPending: () => false,
    run: (_key: string, spec: { mutate: () => Promise<unknown> }) => {
      fixture.mutation = spec.mutate()
    }
  })
}))
vi.mock('@/hooks/useGitHubSlugMetadata', () => ({
  useRepoAssigneesBySlug: () => ({
    data: [{ login: 'octo', name: null, avatarUrl: '' }],
    loading: false,
    error: null
  })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/github/work-item-state-presentation', () => ({ ReviewerAvatar: vi.fn() }))
vi.mock('../../src/main/github/gh-utils', async (original) => ({
  ...(await original<typeof GhUtils>()),
  ghExecFileAsync: fixture.gh,
  acquire: vi.fn(),
  release: vi.fn(),
  getOwnerRepoForRemote: async (_path: string, remote: string) => ({
    owner: remote === 'upstream' ? 'upstream-owner' : 'fork-owner',
    repo: 'widgets'
  })
}))
vi.mock('../../src/main/git/remote-name-listing', () => ({
  shouldProbeGitRemote: async () => true
}))

import { PRAssigneesPanel } from '../../src/renderer/src/components/github/PRAssigneesPanel'
import { updateIssue } from '../../src/main/github/issue-update'
import { _resetOriginGitHubApiRepositoryCache } from '../../src/main/github/github-api-repository'

const repoPath = join(tmpdir(), 'orca-pr-assignee-repository-fixture')

beforeEach(() => {
  fixture.callbacks = []
  fixture.mutation = null
  fixture.requests = []
  fixture.localGitOptions = {}
  fixture.gh.mockReset()
  fixture.gh.mockImplementation(
    async (
      args: string[],
      options: {
        host?: string
        cwd?: string
        wslDistro?: string
      }
    ) => {
      fixture.requests.push({
        args,
        host: options.host,
        cwd: options.cwd,
        wslDistro: options.wslDistro
      })
      return { stdout: '', stderr: '' }
    }
  )
  _resetOriginGitHubApiRepositoryCache()
  fixture.apiUpdate = vi.fn(
    (args: {
      repoPath: string
      number: number
      updates: GitHubIssueUpdate
      ownerRepo?: GitHubOwnerRepo
    }) =>
      updateIssue(
        args.repoPath,
        args.number,
        args.updates,
        null,
        fixture.localGitOptions,
        fixture.preference,
        args.ownerRepo
      )
  )
  vi.stubGlobal('window', { api: { gh: { updateIssue: fixture.apiUpdate } } })
})

afterEach(() => vi.unstubAllGlobals())

it.each([
  { owner: 'upstream-owner', preference: 'origin', assigned: false, legacy: false },
  { owner: 'upstream-owner', preference: 'origin', assigned: true, legacy: false },
  { owner: 'fork-owner', preference: 'upstream', assigned: false, legacy: false },
  { owner: 'fork-owner', preference: 'upstream', assigned: true, legacy: false },
  { owner: 'upstream-owner', preference: 'origin', assigned: false, legacy: true }
] as const)(
  'keeps $owner PR assignees under $preference (remove=$assigned, legacy=$legacy)',
  async ({ owner, preference, assigned, legacy }) => {
    fixture.preference = preference
    fixture.localGitOptions = owner === 'fork-owner' ? { wslDistro: 'Ubuntu' } : {}
    const item: GitHubWorkItem = {
      id: 'pr:5',
      type: 'pr',
      number: 5,
      title: 'Opened PR',
      state: 'open',
      url: `https://github.com/${owner}/widgets/pull/5`,
      prRepo: legacy ? undefined : { owner, repo: 'widgets', host: 'github.com' },
      labels: [],
      updatedAt: '',
      author: null,
      repoId: 'repo-1',
      assignees: assigned ? [{ login: 'octo', name: null, avatarUrl: '' }] : []
    }
    PRAssigneesPanel({ item, repoPath, projectOrigin: undefined, onMutated: vi.fn() })
    const toggleAssignee = fixture.callbacks.at(-1)
    if (typeof toggleAssignee !== 'function') {
      throw new Error('PR panel did not create an assignee handler')
    }
    toggleAssignee('octo')
    await fixture.mutation
    expect(fixture.requests).toEqual([
      {
        args: [
          'issue',
          'edit',
          '5',
          '--repo',
          `${owner}/widgets`,
          assigned ? '--remove-assignee' : '--add-assignee',
          'octo'
        ],
        host: 'github.com',
        cwd: repoPath,
        wslDistro: fixture.localGitOptions.wslDistro
      }
    ])
    expect(fixture.apiUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath,
        repoId: item.repoId,
        ownerRepo: { owner, repo: 'widgets', host: 'github.com' }
      })
    )
  }
)
