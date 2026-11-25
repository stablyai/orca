import { beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import {
  findHostListDeleteRow,
  requestHostListDelete,
  resetHostListDeleteIntentForTest,
  takeHostListDeleteIntent
} from './host-list-delete-intent'

// A spent, stale, or misdirected intent would open a delete confirm the user never asked for.
describe('host list delete intent', () => {
  const target = { hostId: 'desk', executionHost: undefined, worktreeId: 'repo::/w' }
  beforeEach(resetHostListDeleteIntentForTest)

  it('opens once, only for its own token, host and time', () => {
    const token = requestHostListDelete(target, 1_000)
    expect(takeHostListDeleteIntent('', 'desk', 1_000)).toBeNull()
    expect(takeHostListDeleteIntent('other', 'desk', 1_000)).toBeNull()
    expect(takeHostListDeleteIntent(token, 'desk', 1_000)).toEqual(target)
    expect(takeHostListDeleteIntent(token, 'desk', 1_000)).toBeNull()

    const otherHost = requestHostListDelete(target, 1_000)
    expect(takeHostListDeleteIntent(otherHost, 'laptop', 1_000)).toBeNull()
    expect(takeHostListDeleteIntent(otherHost, 'desk', 1_000)).toBeNull()

    const stale = requestHostListDelete(target, 1_000)
    expect(takeHostListDeleteIntent(stale, 'desk', 11_001)).toBeNull()
    expect(takeHostListDeleteIntent(stale, 'desk', 1_000)).toBeNull()

    const replaced = requestHostListDelete(target, 1_000)
    requestHostListDelete({ ...target, worktreeId: 'repo::/x' }, 1_000)
    expect(takeHostListDeleteIntent(replaced, 'desk', 1_000)).toBeNull()
  })

  it('resolves only the row on the same execution host', () => {
    const row = (worktreeId: string, hostId?: string) => ({ worktreeId, hostId }) as Worktree
    const desktopRow = row('repo::/w', 'local')
    const serverRow = row('repo::/w', 'runtime:a')
    const rows = [desktopRow, serverRow, row('repo::/w', 'runtime:b')]
    expect(findHostListDeleteRow(rows, target)).toBe(desktopRow)
    expect(findHostListDeleteRow(rows, { ...target, executionHost: 'runtime:a' })).toBe(serverRow)
    expect(findHostListDeleteRow(rows, { ...target, executionHost: 'runtime:c' })).toBeNull()
    expect(findHostListDeleteRow([desktopRow, row('repo::/w')], target)).toBeNull()
  })
})
