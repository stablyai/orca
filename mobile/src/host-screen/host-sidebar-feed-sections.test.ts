import { describe, expect, it } from 'vitest'
import {
  buildSidebarFeedRows,
  type SidebarFeedView
} from '../../../src/shared/sidebar-list/sidebar-feed-rows'

import { buildSidebarFeedCatalog } from '../../../src/shared/sidebar-list/sidebar-feed-catalog'
import { buildHostFeedView } from './host-sidebar-feed-inputs'
import { buildHostFeedSections } from './host-sidebar-feed-sections'
import {
  SERVED_SECTIONS,
  feedDomains,
  feedKey,
  feedRow,
  phoneView
} from './host-sidebar-feed.test-fixture'
import type { MobileViewState } from '../worktree/workspace-view-settings'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { readServedProjectSections } from '../worktree/project-sections-operations'
import { NO_WORKTREE_HOST_CONTEXT } from '../worktree/worktree-host-context-labels'

function phoneFeedView(
  view: MobileViewState,
  showPinnedInGroups = false,
  hostPlatform: NodeJS.Platform | null = 'darwin'
): SidebarFeedView {
  return buildHostFeedView({
    view,
    projectOrderBy: 'manual',
    desktop: { ...feedDomains().desktop!, showPinnedInGroups },
    hostPlatform
  })
}

describe('the phone list from the sidebar feed', () => {
  it('files a grouped project under its group header, nested and in the group’s order', () => {
    const group = (id: string, name: string, extra: Partial<ProjectGroup> = {}): ProjectGroup => ({
      id,
      name,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0,
      ...extra
    })
    const served = readServedProjectSections({
      id: 'sections',
      ok: true,
      result: {
        catalog: {
          ...SERVED_SECTIONS,
          repos: [
            // Use reversed fixture order so only projectGroupOrder can produce the expected order.
            { ...SERVED_SECTIONS.repos[0]!, projectGroupId: 'pg-inner', projectGroupOrder: 1 },
            { ...SERVED_SECTIONS.repos[1]!, projectGroupId: 'pg-inner', projectGroupOrder: 0 }
          ],
          projectGroups: [
            group('pg-school', 'school'),
            group('pg-inner', 'inner', { parentGroupId: 'pg-school', createdFrom: 'folder-scan' })
          ]
        }
      }
    })
    if (served.kind !== 'answered' || !served.value) {
      throw new Error('expected a served catalog')
    }
    const grouped = buildSidebarFeedCatalog(served.value, [], [])
    const base = feedDomains()
    const domains = feedDomains({
      workspaces: new Map([
        ...base.workspaces,
        [feedKey('|orca::/w/solo'), feedRow({ id: 'orca::/w/solo', manualOrder: 4 })]
      ])
    })
    const built = buildSidebarFeedRows(domains, grouped, phoneFeedView(phoneView()))
    const sections = buildHostFeedSections({
      rows: built.sectionRows,
      lastVisited: null,
      liveRows: [],
      hostContextOf: NO_WORKTREE_HOST_CONTEXT,
      repoHostIdByRepoId: new Map([['lab', 'ssh:gpu']]),
      search: ''
    })
    const headers = sections.map(
      (section) =>
        `${section.title}${section.isProjectGroup ? ' group' : ''} depth=${String(section.projectGroupDepth ?? 0)}`
    )
    expect(headers).toEqual([
      'Pinned depth=0',
      'school group depth=0',
      'inner group depth=1',
      'lab depth=2',
      'orca depth=2'
    ])
    expect(
      sections
        .slice(-2)
        .map((section) =>
          section.data.map((row) => [
            row.view.projectGroupDepth,
            row.view.inFolderScanGroup === true
          ])
        )
    ).toEqual([[[2, true]], [[2, true]]])
    expect(sections.at(-2)?.data.map((row) => row.row.worktreeId)).toEqual(['lab::/w/gpu'])
  })
})
