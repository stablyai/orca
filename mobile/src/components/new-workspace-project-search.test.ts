import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { buildNewWorkspaceProjectOptions } from './new-workspace-project-targets'
import { searchNewWorkspaceProjectOptions } from './new-workspace-project-search'

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
})
