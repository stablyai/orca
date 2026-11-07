vi.mock('../i18n/mobile-i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { describe, expect, it, vi } from 'vitest'
import { buildProjectSectionCatalog } from './project-section-catalog'
import type { ServedProjectSections } from './project-sections-operations'

const uploaded = { type: 'image', src: 'data:image/png;base64,AAAA' }

type ServedRepo = ServedProjectSections['repos'][number]

function repo(
  id: string,
  executionHostId?: ServedRepo['executionHostId'],
  repoIcon?: unknown
): ServedRepo {
  return {
    id,
    displayName: 'orca',
    path: `/repos/${id}`,
    badgeColor: undefined,
    addedAt: undefined,
    connectionId: undefined,
    executionHostId,
    projectGroupId: undefined,
    projectGroupOrder: undefined,
    ...(repoIcon ? { repoIcon } : {})
  }
}

describe('buildProjectSectionCatalog', () => {
  it("restores an uploaded icon from the desktop's repo.list only for the same host's repo", () => {
    const served: ServedProjectSections = {
      repos: [repo('r1'), repo('r1', 'runtime:m4air')],
      projects: [],
      setups: [],
      projectOrderBy: 'manual',
      projectGroups: undefined
    }
    const catalog = buildProjectSectionCatalog(
      served,
      [repo('r1', undefined, uploaded)],
      null,
      'manual'
    )
    expect(catalog.repos.map((entry) => entry.repoIcon)).toEqual([uploaded, undefined])
  })
})

it.each([
  [100, 100],
  [1000, 100],
  [100, 1000],
  [1000, 1000]
])('bounds served and legacy visible-host membership at R=%i H=%i', (repoCount, hostCount) => {
  let hostReads = 0
  let repoReads = 0
  const visible = Array.from(
    { length: hostCount },
    (_, i): `runtime:${string}` => `runtime:host-${i}`
  )
  for (let i = 0; i < hostCount; i++) {
    const value = visible[i]
    Object.defineProperty(visible, i, {
      get: () => {
        hostReads++
        return value
      }
    })
  }
  const repos = Array.from({ length: repoCount }, (_, i) => ({
    ...repo(`r-${i}`),
    get executionHostId(): `runtime:${string}` {
      repoReads++
      return `runtime:host-${hostCount - 1}`
    }
  }))
  for (const served of [
    null,
    { repos, projects: [], setups: [], projectOrderBy: 'manual' as const, projectGroups: undefined }
  ]) {
    hostReads = repoReads = 0
    const result = buildProjectSectionCatalog(served, served ? [] : repos, visible, null)
    expect(result.repos).toEqual(repos)
    expect(hostReads).toBe(hostCount)
    expect(repoReads).toBeLessThanOrEqual(6 * repoCount)
    process.stdout.write(
      `PG6-G ${JSON.stringify({ repoCount, hostCount, served: !!served, hostReads, repoReads })}\n`
    )
  }
  expect(buildProjectSectionCatalog(null, repos, null, null).repos).toBe(repos)
  expect(buildProjectSectionCatalog(null, repos, [], null).repos).toEqual([])
  expect(buildProjectSectionCatalog(null, repos, ['local'], null).repos).toEqual([])
})
