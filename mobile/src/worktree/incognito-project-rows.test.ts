import { describe, expect, it } from 'vitest'
import { hostRepoCatalogSchema } from '../host-screen/host-screen-reply-schema'
import { runtimeRepoListSchema } from '../session/session-read-reply-schema'
import { selectHomeResumeCard } from './home-resume-card'
import type { HomeWorktreeSummary } from './home-worktree-info'
import { relayHostWorktreesRead } from './server-workspace-operations'
import { worktreeCatalogRead } from './worktree-catalog-operations'

function reply(result: unknown) {
  return { id: 'r-1', ok: true as const, result }
}

const repos = [
  { id: 'open', displayName: 'Open' },
  { id: 'secret', displayName: 'Secret', incognito: true },
  { id: 'unmarked', displayName: 'Unmarked', incognito: false }
]

const worktreeRows = [
  { worktreeId: 'open::/a', repoId: 'open' },
  { worktreeId: 'secret::/b', repoId: 'secret', repoIncognito: true }
]

describe('phones drop incognito projects at every reader', () => {
  it('drops incognito repos from the host catalog repo.list', () => {
    const listed = hostRepoCatalogSchema.parse({ repos })
    expect(listed.map((repo) => repo.id)).toEqual(['open', 'unmarked'])
  })

  // One reader behind new-tab, native chat, the new-workspace dialog and the Tasks pickers.
  it('drops incognito repos from the runtime repo.list', () => {
    const listed = runtimeRepoListSchema.parse({ repos })
    expect(listed.map((repo) => repo.id)).toEqual(['open', 'unmarked'])
  })

  it('drops incognito rows from worktree.ps and keeps the unchanged envelope', () => {
    const full = worktreeCatalogRead.interpret(reply({ snapshotId: 's', worktrees: worktreeRows }))
    expect(full.accepted && full.value.worktrees).toEqual([worktreeRows[0]])
    const unchanged = worktreeCatalogRead.interpret(reply({ snapshotId: 's', unchanged: true }))
    expect(unchanged.accepted && unchanged.value.worktrees).toBe(undefined)
  })

  it("drops incognito rows from a server's relayed rows", () => {
    const verdict = relayHostWorktreesRead.interpret(reply({ worktrees: worktreeRows }))
    expect(verdict.accepted && verdict.value.worktrees).toEqual([worktreeRows[0]])
    const none = relayHostWorktreesRead.interpret(reply({ worktrees: null }))
    expect(none.accepted && none.value.worktrees).toBe(null)
  })

  it('never resumes a persisted incognito workspace', () => {
    const hidden: HomeWorktreeSummary & { repoIncognito: true } = {
      worktreeId: 'secret::/b',
      repo: 'Secret',
      branch: 'main',
      displayName: 'b',
      liveTerminalCount: 0,
      repoIncognito: true
    }
    const card = selectHomeResumeCard({
      hosts: [{ id: 'host-1' }],
      hostStates: { 'host-1': 'connected' },
      worktreeInfo: {
        'host-1': {
          hostId: 'host-1',
          totalWorktrees: 1,
          activeCount: 0,
          lastActiveWorktree: hidden
        }
      },
      lastVisited: { hostId: 'host-1', worktreeId: hidden.worktreeId },
      cachedWorktrees: () => [hidden]
    })
    expect(card).toBe(null)
  })
})
