import { describe, expect, it } from 'vitest'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { NODE_PLATFORM_NAMES } from '../transport/mobile-runtime-host-platform'
import {
  hostPlatformSchema,
  hostProjectGroupListSchema,
  hostRepoCatalogSchema,
  hostSshTargetSummariesSchema,
  hostViewSettingsSchema,
  WORKSPACE_GROUP_BY_ARMS,
  WORKSPACE_SORT_BY_ARMS
} from './host-screen-reply-schema'

describe('host screen reply schemas', () => {
  it('requires the repo list and drops a row no map could key', () => {
    expect(hostRepoCatalogSchema.safeParse({}).success).toBe(false)
    const parsed = hostRepoCatalogSchema.parse({
      repos: [{ id: 'r1', displayName: 'orca' }, { id: 'r2' }, { displayName: 'ghost' }]
    })
    expect(parsed.map((repo) => repo.id)).toEqual(['r1'])
  })

  it('salvages badgeColor onto the generated swatch main fell back to', () => {
    expect(
      hostRepoCatalogSchema.parse({ repos: [{ id: 'r', displayName: 'o', badgeColor: 3 }] })[0]
        ?.badgeColor
    ).toBeUndefined()
  })

  it('keeps a known repo icon arm and degrades an unknown one to absent', () => {
    const known = hostRepoCatalogSchema.parse({
      repos: [{ id: 'r', displayName: 'o', repoIcon: { type: 'emoji', emoji: 'x' } }]
    })
    expect(known[0]?.repoIcon).toEqual({ type: 'emoji', emoji: 'x' })
    const unknown = hostRepoCatalogSchema.parse({
      repos: [{ id: 'r', displayName: 'o', repoIcon: { type: 'svg', markup: '<svg/>' } }]
    })
    // The row survives and draws the Folder default MobileRepoIcon already drew for an arm it
    // could not match.
    expect(unknown[0]?.id).toBe('r')
    expect(unknown[0]?.repoIcon).toBeUndefined()
  })

  it('keeps an image icon whose source this build has never heard of', () => {
    const [repo] = hostRepoCatalogSchema.parse({
      repos: [
        {
          id: 'r',
          displayName: 'o',
          repoIcon: {
            type: 'image',
            src: 'https://example.invalid/a.png',
            source: 'gitlab',
            label: 'acme/orca'
          }
        }
      ]
    })
    // MobileRepoIcon reads src and label and never source, so narrowing source would have drawn a
    // Folder where main drew the image. The member itself still reaches the row.
    expect(repo?.repoIcon).toEqual({
      type: 'image',
      src: 'https://example.invalid/a.png',
      source: 'gitlab',
      label: 'acme/orca'
    })
  })

  it('keeps project group membership used to nest the workspace list', () => {
    const [repo] = hostRepoCatalogSchema.parse({
      repos: [
        {
          id: 'r',
          displayName: 'o',
          projectGroupId: 'group-1',
          projectGroupOrder: 2
        }
      ]
    })
    expect(repo?.projectGroupId).toBe('group-1')
    expect(repo?.projectGroupOrder).toBe(2)
  })

  it('passes a host-id spelling through for getRepoExecutionHostId to judge', () => {
    const [repo] = hostRepoCatalogSchema.parse({
      repos: [{ id: 'r', displayName: 'o', executionHostId: 'cloud:zone-a', connectionId: null }]
    })
    expect(repo?.executionHostId).toBe('cloud:zone-a')
    expect(repo?.connectionId).toBeNull()
  })

  it('reads project groups and degrades an unreadable list to empty', () => {
    expect(
      hostProjectGroupListSchema.parse({
        groups: [
          { id: 'g1', name: 'Client A', parentGroupId: 'root', tabOrder: 3 },
          { id: 'g2', name: 'Nested' },
          { name: 'dropped' }
        ]
      })
    ).toEqual([
      { id: 'g1', name: 'Client A', parentGroupId: 'root', tabOrder: 3 },
      { id: 'g2', name: 'Nested', parentGroupId: null, tabOrder: 0 }
    ])
    expect(hostProjectGroupListSchema.parse({})).toEqual([])
    expect(hostProjectGroupListSchema.parse(null)).toEqual([])
  })

  it('degrades an unreadable ssh target list to the empty one that falls back to host ids', () => {
    expect(hostSshTargetSummariesSchema.parse({})).toEqual([])
    expect(hostSshTargetSummariesSchema.parse({ targets: 'none' })).toEqual([])
    expect(
      hostSshTargetSummariesSchema.parse({
        targets: [{ id: 't', label: 'T' }, { id: 'u' }, { label: 'V' }]
      })
    ).toEqual([{ id: 't', label: 'T' }])
  })

  it('answers the empty target list for a reply that is no object at all', () => {
    // Why: the label write runs before the platform write in the same sequence, so a throw here
    // would take the platform down with it. readSshTargets answered [] for every one of these.
    for (const payload of [null, undefined, 'nope', 42, []]) {
      expect(hostSshTargetSummariesSchema.parse(payload)).toEqual([])
    }
  })

  it('reads only a platform Node could have reported', () => {
    expect(hostPlatformSchema.parse({ platform: 'win32' })).toBe('win32')
    expect(hostPlatformSchema.parse({ platform: 'plan9' })).toBeNull()
    expect(hostPlatformSchema.parse({ platform: '' })).toBeNull()
    expect(hostPlatformSchema.parse({})).toBeNull()
    for (const payload of [null, undefined, 'nope', 42]) {
      expect(hostPlatformSchema.parse(payload)).toBeNull()
    }
  })

  it('requires the ui member main read with a bare property access', () => {
    expect(hostViewSettingsSchema.safeParse({}).success).toBe(false)
    expect(hostViewSettingsSchema.safeParse(null).success).toBe(false)
    expect(hostViewSettingsSchema.parse({ ui: {} })).toEqual({})
  })

  it('degrades an unknown grouping or sort arm to absent so the local mode is kept', () => {
    const parsed = hostViewSettingsSchema.parse({
      ui: { groupBy: 'agent', sortBy: 'stars', hideSleepingWorkspaces: 'yes' }
    })
    expect(parsed.groupBy).toBeUndefined()
    expect(parsed.sortBy).toBeUndefined()
    expect(parsed.hideSleepingWorkspaces).toBeUndefined()
  })

  it('keeps the known view arms and the lists the screen adopts', () => {
    const parsed = hostViewSettingsSchema.parse({
      ui: {
        groupBy: 'workspace-status',
        sortBy: 'recent',
        filterRepoIds: ['r1'],
        collapsedGroups: [],
        workspaceStatuses: [{ id: 'active', label: 'Active' }]
      }
    })
    expect(parsed.groupBy).toBe('workspace-status')
    expect(parsed.sortBy).toBe('recent')
    expect(parsed.filterRepoIds).toEqual(['r1'])
    expect(parsed.workspaceStatuses).toEqual([{ id: 'active', label: 'Active' }])
  })

  it('salvages a non-array status catalog rather than handing a string to the group lookups', () => {
    expect(
      hostViewSettingsSchema.parse({ ui: { workspaceStatuses: 'active' } }).workspaceStatuses
    ).toBeUndefined()
  })
})

describe('the closed arm sets are the desktop unions', () => {
  // The arm lists are pinned to the desktop unions in the schema modules, where tsc looks; these
  // loops prove every pinned arm survives the parse, not just the ones the tests above pick.
  it('keeps every platform Node can report', () => {
    for (const platform of NODE_PLATFORM_NAMES) {
      expect(hostPlatformSchema.parse({ platform })).toBe(platform)
    }
  })

  it('keeps every grouping and sort arm the desktop persists', () => {
    for (const groupBy of WORKSPACE_GROUP_BY_ARMS) {
      for (const sortBy of WORKSPACE_SORT_BY_ARMS) {
        expect(hostViewSettingsSchema.parse({ ui: { groupBy, sortBy } })).toMatchObject({
          groupBy,
          sortBy
        })
      }
    }
  })

  it('keeps every repo icon arm the desktop draws', () => {
    const icons: Record<RepoIcon['type'], Record<string, string>> = {
      lucide: { type: 'lucide', name: 'Folder' },
      emoji: { type: 'emoji', emoji: '🐳' },
      image: { type: 'image', src: 'data:,x' }
    }
    for (const repoIcon of Object.values(icons)) {
      const [row] = hostRepoCatalogSchema.parse({
        repos: [{ id: 'r', displayName: 'r', repoIcon }]
      })
      expect(row?.repoIcon).toMatchObject({ type: repoIcon.type })
    }
  })
})
