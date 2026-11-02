import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import { normalizeLoadedProjectCatalog } from './normalize-loaded-state-collections'

function corrupt<T extends object>(row: T, overrides: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(overrides)) {
    Reflect.set(row, key, value)
  }
  return row
}

function makeParsed(
  setups: ProjectHostSetup[],
  projects: Project[] = []
): Partial<Pick<PersistedState, 'projects' | 'projectHostSetups'>> {
  return { projects, projectHostSetups: setups }
}

function makeBadSetup(): ProjectHostSetup {
  const setup: ProjectHostSetup = {
    id: 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/Users/alice/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
  return corrupt(setup, { repoId: null, path: null })
}

describe('normalizeLoadedProjectCatalog', () => {
  it('repairs stored rows whose field types do not match the declared ones', () => {
    const result = normalizeLoadedProjectCatalog(makeParsed([makeBadSetup()]), vi.fn())
    expect(result.projectHostSetups[0]?.repoId).toBe('')
    expect(result.projectHostSetups[0]?.path).toBe('')
  })

  it('marks the profile dirty so the repair is persisted', () => {
    const markNeedsSave = vi.fn()
    normalizeLoadedProjectCatalog(makeParsed([makeBadSetup()]), markNeedsSave)
    expect(markNeedsSave).toHaveBeenCalled()
  })

  it('leaves a conforming catalog untouched and does not schedule a save', () => {
    const markNeedsSave = vi.fn()
    const setups = [{ ...makeBadSetup(), repoId: 'repo-1', path: '/repo' }]
    const parsed = makeParsed(setups)
    const result = normalizeLoadedProjectCatalog(parsed, markNeedsSave)
    expect(result.projectHostSetups).toBe(setups)
    expect(markNeedsSave).not.toHaveBeenCalled()
  })

  it('tolerates missing or non-array collections', () => {
    const result = normalizeLoadedProjectCatalog({}, vi.fn())
    expect(result.projects).toEqual([])
    expect(result.projectHostSetups).toEqual([])
    const malformed = corrupt(makeParsed([], []), {
      projects: 'not-an-array',
      projectHostSetups: {}
    })
    expect(normalizeLoadedProjectCatalog(malformed, vi.fn())).toEqual({
      projects: [],
      projectHostSetups: []
    })
  })
})
