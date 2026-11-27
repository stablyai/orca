import { describe, expect, it } from 'vitest'
import { countUnreadWorkspaces } from './unread-workspace-count'

const repo = (id: string, executionHostId?: string) => ({ id, path: `/${id}`, executionHostId })
const meta = (fields: { isUnread?: boolean; isArchived?: boolean }) => ({
  isUnread: false,
  isArchived: false,
  ...fields
})

describe('countUnreadWorkspaces', () => {
  it('counts unread workspaces this host owns, not archived ones or a paired runtime’s', () => {
    const metaByHost: Record<string, Record<string, ReturnType<typeof meta>>> = {
      local: {
        'mine::/a': meta({ isUnread: true }),
        'mine::/b': meta({ isUnread: true, isArchived: true }),
        'mine::/c': meta({}),
        'gone::/d': meta({ isUnread: true })
      },
      'ssh:box': { 'remote::/e': meta({ isUnread: true }) },
      'runtime:paired': { 'mirrored::/f': meta({ isUnread: true }) }
    }
    const store = {
      getRepos: () => [repo('mine'), repo('remote', 'ssh:box'), repo('mirrored', 'runtime:paired')],
      getAllWorktreeMeta: () => ({}),
      getAllWorktreeMetaForHost: (hostId: string) => metaByHost[hostId] ?? {},
      getProjectGroups: () => [],
      getFolderWorkspaces: () => [
        { id: 'notes', ...meta({ isUnread: true }) },
        { id: 'paired-notes', executionHostId: 'runtime:paired', ...meta({ isUnread: true }) }
      ],
      getSshTargets: () => [],
      getProjectHostSetups: () => []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the count reads only the fields these rows set
    expect(countUnreadWorkspaces(store as never)).toBe(3)
  })
})
