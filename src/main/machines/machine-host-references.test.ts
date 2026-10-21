import { describe, expect, it } from 'vitest'
import { isMachineHostReferenced } from './machine-host-references'

const noProjects = { getRepos: () => [], getFolderWorkspaces: () => [] }

describe('isMachineHostReferenced', () => {
  it('keeps a managed server environment referenced while it is saved, with no local project', () => {
    expect(isMachineHostReferenced(noProjects, () => ['env-1'], 'runtime:env-1')).toBe(true)
    expect(isMachineHostReferenced(noProjects, () => [], 'runtime:env-1')).toBe(false)
  })

  it('counts local repos and folder workspaces on an SSH target or environment', () => {
    const projects = {
      getRepos: () => [{ connectionId: 'machine-abc', executionHostId: null }],
      getFolderWorkspaces: () => [{ connectionId: null, executionHostId: 'runtime:env-2' as const }]
    }
    expect(isMachineHostReferenced(projects, () => [], 'ssh:machine-abc')).toBe(true)
    expect(isMachineHostReferenced(projects, () => [], 'runtime:env-2')).toBe(true)
    expect(isMachineHostReferenced(projects, () => [], 'ssh:machine-other')).toBe(false)
  })
})
