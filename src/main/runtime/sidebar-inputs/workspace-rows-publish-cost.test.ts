// What one metadata write costs main to publish at 1000 workspaces: the real store, join, visibility
// filter, row builder and feed diff; only git is stubbed, as the cached scan it would have left.
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { fixture } from '../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedWorktreeRepoScans } from '../workspaces/resolved-worktree-scan-join'
import { requireSwitchedOn } from './require-switched-on'
import { TestPhone } from './sidebar-inputs-feed.test-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WORKSPACES = 1000
const WRITES = 60
const repo: Repo = {
  id: 'repo-big',
  path: '/big',
  displayName: 'big',
  badgeColor: 'blue',
  addedAt: 1
}
const checkouts: GitWorktreeInfo[] = Array.from({ length: WORKSPACES }, (_, index) => ({
  path: `/big/wt-${index}`,
  head: `${index}`.padStart(40, '0'),
  branch: `refs/heads/branch-${index}`,
  isBare: false,
  isMainWorktree: index === 0
}))

class CachedGitRuntime extends OrcaRuntimeService {
  protected override async scanResolvedWorktreeRepos(): Promise<ResolvedWorktreeRepoScans> {
    // The profile fixture's own repos scanned as empty, so every repo has its cached scan.
    return new Map(
      (this.store?.getRepos() ?? []).map((entry) => [
        getRepoHostIdentityForParts(entry.id, getRepoExecutionHostId(entry)),
        { ok: true, worktrees: entry.id === repo.id ? checkouts : [], gitRun: null }
      ])
    )
  }
}

describe('workspace rows publish cost', () => {
  it('publishes a metadata write at 1000 workspaces well inside the action bar', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = await fixture()
    store.addRepo(repo)
    // Checkouts outside the workspace directory count as external; show them, as a long-time user does.
    store.updateSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real Store is a RuntimeStore.
    const runtime = new CachedGitRuntime(store as unknown as RuntimeStore)
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(Object.keys(phone.view().workspaces ?? {}).length).toBeGreaterThanOrEqual(WORKSPACES)

    const costs: number[] = []
    for (let index = 0; index < WRITES; index += 1) {
      const published = new Promise<void>((resolve) => {
        const detach = runtime.onClientEvent((event: RuntimeClientEvent) => {
          if (event.type === 'sidebarInputsChanged') {
            detach()
            resolve()
          }
        })
      })
      const startedAt = performance.now()
      store.setWorktreeMeta(
        hostWorktreeTarget({ id: `${repo.id}::/big/wt-${index}`, hostId: 'local' }),
        { isPinned: true }
      )
      await published
      costs.push(performance.now() - startedAt)
    }
    // The first few warm the JIT; the bar is a maximum, so report it over every write.
    const sorted = [...costs].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const max = sorted.at(-1) ?? 0
    const burstCpu = (median * 5) / 10
    process.stdout.write(
      `[publish-cost] ${WORKSPACES} workspaces, ${WRITES} writes: median ${median.toFixed(2)} ms, ` +
        `max ${max.toFixed(2)} ms; a 5/s burst ≈ ${burstCpu.toFixed(1)}% of one core\n`
    )
    // The median, not the max: one descheduled write on a loaded CI runner is not this code's cost.
    expect(median).toBeLessThan(100)
    phone.disconnect()
  }, 120_000)
})
