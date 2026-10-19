import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { OWNED_SESSION_KINDS, OWNED_SESSION_TEARDOWN } from './owned-session-teardown-policy'
import {
  getRuntimeBrowserPageRegistry,
  type RuntimeBrowserClientPage
} from './runtime-browser-page-registry'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

function makeRuntime() {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const sleepPhases = (): string[] =>
    events.flatMap((event) => (event.type === 'worktreeTerminalSleepState' ? [event.phase] : []))
  return { runtime, runtimeStore, sleepPhases }
}

describe('owned-session teardown policy', () => {
  it('pins the decided policy for every kind and entry point', () => {
    const removal = {
      pty: 'stop',
      'structured-chat': 'stop',
      'host-browser': 'stop',
      launch: 'stop'
    }
    expect(OWNED_SESSION_KINDS).toEqual(['pty', 'structured-chat', 'host-browser', 'launch'])
    expect(OWNED_SESSION_TEARDOWN).toEqual({
      'worktree-removal': removal,
      'folder-removal': removal,
      'project-removal': removal,
      sleep: {
        pty: 'stop',
        'structured-chat': 'stop-pending-28445',
        'host-browser': 'retain',
        launch: 'retain'
      },
      // Loss of contact is never evidence of exit.
      disconnect: {
        pty: 'retain',
        'structured-chat': 'retain',
        'host-browser': 'retain',
        launch: 'retain'
      }
    })
  })

  it('sleeps the terminals on the host when no renderer can run the sleep flow', async () => {
    const { runtime, sleepPhases } = makeRuntime()

    await runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    // Settled: the host now refuses an automatic spawn into the slept worktree.
    expect(sleepPhases()[0]).toBe('started')
    await expect(
      runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID, { refuseSleptWorktree: true })
    ).rejects.toThrow()
  })

  it('never reports a headless sleep whose stop is unproven as done', async () => {
    const { runtime } = makeRuntime()
    vi.spyOn(runtime, 'sleepTerminalsForWorktree').mockResolvedValue({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_worktree_sleep_still_live',
      remainingLivePtyIds: ['pty-1']
    })

    await expect(runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_still_live'
    )
  })

  it('leaves the sleep to an attached renderer', async () => {
    const { runtime, sleepPhases } = makeRuntime()
    const sleepWorktree = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sleepManagedWorktree reads only sleepWorktree.
    runtime.setNotifier({ sleepWorktree } as unknown as RuntimeNotifier)

    await runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(sleepWorktree).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(sleepPhases()).toEqual([])
  })

  it("project removal finds a headless page's workspace through the browser bridge", async () => {
    const { runtime, runtimeStore } = makeRuntime()
    const [repo] = runtimeStore.getRepos()
    vi.spyOn(runtimeStore, 'getRepos').mockReturnValue([])
    vi.spyOn(getRuntimeBrowserPageRegistry(runtime), 'listPages').mockReturnValue([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only tabWorktreeIds.
    runtime.setAgentBrowserBridge({
      tabWorktreeIds: () => [TEST_WORKTREE_ID]
    } as unknown as AgentBrowserBridge)
    const release = vi.spyOn(runtime, 'releaseRemovedWorktreeHostSessions')

    await runtime.stopTerminalsForProject(repo, { closeStructuredSessions: true })

    expect(release).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'project-removal')
  })

  it.each([
    { survivingRow: false, released: [TEST_WORKTREE_ID] },
    // Page records carry no host, so a same-id row on another host keeps every page.
    { survivingRow: true, released: [] }
  ])(
    "project removal releases its workspaces' host pages (surviving row: $survivingRow)",
    async ({ survivingRow, released }) => {
      const { runtime, runtimeStore } = makeRuntime()
      const repos = runtimeStore.getRepos()
      vi.spyOn(runtimeStore, 'getRepos').mockReturnValue(survivingRow ? repos : [])
      vi.spyOn(getRuntimeBrowserPageRegistry(runtime), 'listPages').mockReturnValue([
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only workspaceId is read.
        { workspaceId: TEST_WORKTREE_ID } as RuntimeBrowserClientPage,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only workspaceId is read.
        { workspaceId: 'other-repo::/elsewhere' } as RuntimeBrowserClientPage
      ])
      const release = vi.spyOn(runtime, 'releaseRemovedWorktreeHostSessions')

      await runtime.stopTerminalsForProject(repos[0], { closeStructuredSessions: true })

      expect(release.mock.calls.map(([worktreeId]) => worktreeId)).toEqual(released)
    }
  )
})
