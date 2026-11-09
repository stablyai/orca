import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { buildNewWorkspaceProjectOptions } from './new-workspace-project-targets'
import {
  quickPickNewWorkspaceTargets,
  searchNewWorkspaceProjectOptions
} from './new-workspace-project-search'

const upstream = { owner: 'stablyai', repo: 'orca' }
const repos = [
  { id: 'local', displayName: 'orca', path: '/src/orca', upstream },
  { id: 'ssh', displayName: 'orca', path: '/home/dev/orca', connectionId: 'build-box', upstream },
  { id: 'docs', displayName: 'docs', path: '/src/docs' }
]
const hostLabelFor = (repo: (typeof repos)[number]) =>
  repo.connectionId ? 'build-box' : 'This Mac'

describe('searchNewWorkspaceProjectOptions', () => {
  const options = buildNewWorkspaceProjectOptions(repos)

  it('filters projects by name as you type', () => {
    const result = searchNewWorkspaceProjectOptions(options, repos, 'orc', hostLabelFor)
    expect(result.map((option) => option.label)).toEqual(['orca'])
  })

  it('suggests only that host when host and project are typed', () => {
    const [only, ...rest] = searchNewWorkspaceProjectOptions(
      options,
      repos,
      'build orca',
      hostLabelFor
    )
    expect(rest).toEqual([])
    expect(only).toMatchObject({ label: 'orca', detail: 'build-box' })
    expect(getRepoExecutionHostId(only.repo)).toBe(getRepoExecutionHostId(repos[1]))
  })

  it('ranks a project named like the query above projects that match only through the host', () => {
    const linuxRepos = [
      { id: 'api', displayName: 'api', path: '/src/api' },
      { id: 'kernel', displayName: 'linux', path: '/src/linux' }
    ]
    const result = searchNewWorkspaceProjectOptions(
      buildNewWorkspaceProjectOptions(linuxRepos),
      linuxRepos,
      'linux',
      () => 'Local Linux'
    )
    expect(result.map((option) => option.label)).toEqual(['linux', 'api'])
  })
})

describe('quickPickNewWorkspaceTargets', () => {
  const options = buildNewWorkspaceProjectOptions(repos)
  const pick = (query: string, hostId: string | null = null) =>
    quickPickNewWorkspaceTargets(options, repos, query, hostLabelFor, hostId, 5).map(
      (row) => `${row.label}@${row.hostLabel}`
    )

  it('offers one row per project and host so a pick sets both', () => {
    expect(pick('orca')).toEqual(['orca@This Mac', 'orca@build-box'])
    expect(pick('build orca')).toEqual(['orca@build-box'])
    const [only] = quickPickNewWorkspaceTargets(options, repos, 'build orca', hostLabelFor, null, 5)
    expect(getRepoExecutionHostId(only.repo)).toBe(getRepoExecutionHostId(repos[1]))
  })

  it('narrows to the host chosen as a quick filter', () => {
    expect(pick('', getRepoExecutionHostId(repos[0]))).toEqual(['orca@This Mac', 'docs@This Mac'])
  })
})
