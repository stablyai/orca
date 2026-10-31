// A same-id SSH twin is a different workspace: its spawn must not wake or be refused by this computer's sleep.
import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { spawnWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from './worktree-terminals-sleeping-error'
import { resolveWorktreeLaunchHost } from './worktree-launch-host-repo'
import { resolveSleepScope } from './terminal/stop/worktree-terminal-sleep-key'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } =
  await import('./orca-runtime-test-fixtures.spec')

// Runtime-nested SSH routes are not dialled from this process.
const nestedSshRepo = {
  ...store.getRepos()[0],
  executionHostId: 'runtime:env-a' as const,
  connectionId: 'ssh-nested'
}
const nestedSshStore = {
  ...store,
  getRepo: () => nestedSshRepo,
  getRepos: () => [nestedSshRepo]
}

const TWIN_PTY_ID = toAppSshPtyId('ssh-twin', 'relay-pty-1')
const twinPty = {
  id: TWIN_PTY_ID,
  cwd: TEST_WORKTREE_PATH,
  title: 'Shell',
  worktreeId: TEST_WORKTREE_ID
}

async function sleepLocalCopy(runtimeStore: typeof store = store, twinLive = false) {
  const runtime = new OrcaRuntimeService(runtimeStore)
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const twin = twinLive ? [twinPty] : []
  const processLists = [
    [{ id: 'pty-local', cwd: TEST_WORKTREE_PATH, title: 'Shell' }, ...twin],
    twin
  ]
  const stopAndWait = vi.fn(async (ptyId: string) => {
    runtime.onPtyExit(ptyId, -1)
    return true
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait,
    getForegroundProcess: async () => null,
    listProcesses: async () => processLists.shift() ?? []
  })
  await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
    stopped: 1,
    postStopVerified: true
  })
  const phases = (): string[] =>
    events.flatMap((event) => (event.type === 'worktreeTerminalSleepState' ? [event.phase] : []))
  return { runtime, phases, stopAndWait }
}

describe('worktree terminal sleep across same-id host twins', () => {
  it("a spawn on the SSH twin neither wakes nor is refused by this computer's sleep", async () => {
    const { runtime, phases } = await sleepLocalCopy()
    const twin = spawnWorktreeTarget(TEST_WORKTREE_ID, 'ssh-twin')

    const releaseRefusable = await runtime.acquireWorktreeTerminalSpawn(twin, {
      refuseSleptWorktree: true
    })
    releaseRefusable()
    const releaseTwin = await runtime.acquireWorktreeTerminalSpawn(twin)
    releaseTwin()

    expect(phases()).not.toContain('woken')
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ worktreeId: TEST_WORKTREE_ID, phase: 'committed' })
    ])
  })

  it("this computer's own spawn still refuses or wakes its sleep", async () => {
    const { runtime, phases } = await sleepLocalCopy()
    const local = spawnWorktreeTarget(TEST_WORKTREE_ID, null)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(local, { refuseSleptWorktree: true })
    ).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    const release = await runtime.acquireWorktreeTerminalSpawn(local)
    release()

    expect(phases()).toContain('woken')
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([])
  })

  it("a runtime-stamped project's launch-scope spawn refuses and wakes its sleep", async () => {
    const { runtime, phases } = await sleepLocalCopy(nestedSshStore)
    // The connection the launch scope hands the spawn, not one predicted from the row.
    const launch = resolveWorktreeLaunchHost(nestedSshStore.getRepos(), {
      repoId: nestedSshRepo.id
    })
    expect(launch.kind).toBe('resolved')
    const nested = spawnWorktreeTarget(
      TEST_WORKTREE_ID,
      launch.kind === 'resolved' ? launch.connectionId : undefined
    )

    await expect(
      runtime.acquireWorktreeTerminalSpawn(nested, { refuseSleptWorktree: true })
    ).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    const release = await runtime.acquireWorktreeTerminalSpawn(nested)
    release()

    expect(phases()).toContain('woken')
  })

  it("sleeping this computer's copy leaves the SSH twin's live terminal running and unfiled", async () => {
    const { runtime, phases, stopAndWait } = await sleepLocalCopy(store, true)

    expect(stopAndWait.mock.calls.map(([ptyId]) => ptyId)).toEqual(['pty-local'])
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-local'] })
    ])
    const release = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, 'ssh-twin')
    )
    release()
    expect(phases()).not.toContain('woken')
  })

  it('refuses to sleep a worktree whose rival rows disagree about its host', () => {
    const local = store.getRepos()[0]
    const rivals = [local, { ...local, connectionId: 'ssh-twin' }]

    expect(() => resolveSleepScope(rivals, { id: TEST_WORKTREE_ID, repoId: local.id })).toThrow(
      'worktree_execution_host_unresolved'
    )
  })
})
