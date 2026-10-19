import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { spawnWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import {
  OWNED_SESSION_KINDS,
  OWNED_SESSION_TEARDOWN,
  type OwnedSessionKind
} from './owned-session-teardown-policy'
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
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, null), {
        refuseSleptWorktree: true
      })
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

  it("stops every project workspace's terminals under one deadline, not one after another", async () => {
    const { runtime, runtimeStore } = makeRuntime()
    const [repo] = runtimeStore.getRepos()
    const slow = `${repo.id}::/slow`
    const fast = `${repo.id}::/fast`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only id and repoId.
    const worktrees = new Map([slow, fast].map((id) => [id, { id, repoId: repo.id }])) as never
    vi.spyOn(runtime, 'getResolvedWorktreeMap').mockResolvedValue(worktrees)
    const stop = vi.spyOn(runtime, 'stopTerminalsForWorktree').mockImplementation(
      async (selector) =>
        await new Promise<{ stopped: number }>((resolve) => {
          // The slow workspace's provider never answers; the fast one takes a moment.
          if (selector === `id:${fast}`) {
            setTimeout(() => resolve({ stopped: 1 }), 20)
          }
        })
    )

    const result = await runtime.stopTerminalsForProject(repo, { deadline: Date.now() + 500 })

    expect(stop.mock.calls.map(([selector]) => selector).sort()).toEqual([
      `id:${fast}`,
      `id:${slow}`
    ])
    expect(result.stopped).toBe(1)
  })
})

// Every exported or method-level stop/close/teardown of a workspace's sessions in src/main/runtime,
// and the owned-session kinds it ends. A new one fails here until someone classifies it.
const TEARDOWN_FUNCTIONS: Readonly<Record<string, readonly OwnedSessionKind[]>> = {
  closeClientHostedBrowserPagesForWorktree: ['host-browser'],
  closeStructuredSessionsForProject: ['structured-chat'],
  closeStructuredSessionsForWorktree: ['structured-chat'],
  retireStructuredSessionTabsForWorktree: ['structured-chat'],
  closeTerminalsForWorktree: ['pty'],
  killAllProcessesForWorktree: ['pty', 'structured-chat'],
  sleepTerminalsForWorktree: ['pty'],
  stopExactTerminalsForWorktree: ['pty'],
  stopTerminalsForWorktree: ['pty'],
  stopTerminalsForProject: ['pty', 'structured-chat', 'host-browser', 'launch']
}

// Functions, `const` arrows and class members; a call or import matching it is harmless.
const TEARDOWN_NAME =
  /(?:^(?:export )?(?:async )?function |^(?:export )?(?:const|let) |^\s+(?:(?:async|private|protected|public|override|static|abstract|readonly) )*)((?:stop|close|teardown|kill|sleep|retire|forget)\w*For(?:Worktree|Project)s?)\b/gm

function declaredTeardownFunctions(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return declaredTeardownFunctions(path)
    }
    if (!entry.name.endsWith('.ts') || /\.(test|spec)\.ts$|\.test-fixture\.ts$/.test(entry.name)) {
      return []
    }
    return [...readFileSync(path, 'utf8').matchAll(TEARDOWN_NAME)].map((match) => match[1])
  })
}

describe('owned-session teardown walk', () => {
  const declared = new Set(declaredTeardownFunctions(__dirname))

  it('classifies every stop, close and teardown of a workspace in src/main/runtime', () => {
    expect([...declared].filter((name) => !(name in TEARDOWN_FUNCTIONS)).sort()).toEqual([])
    expect(Object.keys(TEARDOWN_FUNCTIONS).filter((name) => !declared.has(name))).toEqual([])
  })

  it('reaches every owned-session kind', () => {
    const reached = new Set(Object.values(TEARDOWN_FUNCTIONS).flat())
    expect(OWNED_SESSION_KINDS.filter((kind) => !reached.has(kind))).toEqual([])
  })
})
