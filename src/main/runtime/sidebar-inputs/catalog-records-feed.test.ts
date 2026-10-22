import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { ProducerRevision } from './producer-revision'
import { catalogRecordEntities, createCatalogRecordsFeed } from './catalog-records-feed'

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return { id, path: `/p/${id}`, displayName: id, badgeColor: 'blue', addedAt: 1, ...extra }
}

function group(id: string): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local'
  }
}

describe('catalogRecordEntities', () => {
  it('keys each row on its own and keeps the order apart, so a rename re-sends one row', () => {
    const entities = catalogRecordEntities({
      repos: [repo('a'), repo('b')],
      projectGroups: [group('g')],
      projects: [],
      projectHostSetups: []
    })
    expect(Object.keys(entities).filter((key) => key.startsWith('repo:'))).toHaveLength(2)
    expect(entities.order).toMatchObject({ projectGroups: ['group:local\0g'] })
  })

  it('keeps two rows with one identity apart, in order', () => {
    const entities = catalogRecordEntities({
      repos: [repo('a'), repo('a')],
      projectGroups: [],
      projects: [],
      projectHostSetups: []
    })
    expect(entities.order).toMatchObject({ repos: ['repo:local\0a', 'repo:local\0a#1'] })
  })
})

describe('createCatalogRecordsFeed', () => {
  it("answers from main's store at once: the catalog waits on no workspace scan", async () => {
    const store = {
      getRepos: () => [repo('a')],
      getProjectGroups: () => [],
      getFolderWorkspaces: () => [],
      getSshTargets: () => [],
      getProjectHostSetups: () => [],
      getProjects: () => [],
      getUI: () => ({ projectOrderBy: 'manual' as const, manualRepoOrder: [] })
    }
    const feed = createCatalogRecordsFeed(
      {
        store: () => store,
        pairedServerRows: { revision: new ProducerRevision(), catalogs: () => [] },
        onClientEvent: () => () => {}
      },
      () => {}
    )
    feed.acquire('window')
    const reply = await feed.read({ maxBytes: 256 * 1024 })
    expect(reply.kind).toBe('snapshot')
    expect(Object.keys(reply.domains.catalogRecords?.upserts ?? {})).toContain('order')
  })
})
