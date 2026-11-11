// An update counts the server's terminals, then stops it: a terminal started between the two
// would die with the stop, uncounted. The last census closes admission so none can start.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  OrcadTerminalCensusParamsSchema
} from '../../../../shared/orcad-terminal-census'
import { TerminalHost } from '../../../daemon/terminal-host/terminal-host'
import { resolveWorktreeScanRuntime } from '../../workspaces/catalog/runtime-worktree-scan-cache'
import type * as ProviderDispatch from '../../../providers/execution-host-provider-dispatch'
import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { ORCAD_TERMINAL_CENSUS_METHODS } from '../../rpc/methods/orcad/orcad-terminal-census'
import { TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE } from './terminal-update-admission'

const { collect, listLiveDaemonPtyIds, rootQuery } = vi.hoisted(() => ({
  collect: vi.fn(),
  rootQuery: vi.fn(),
  listLiveDaemonPtyIds: vi.fn<() => Promise<string[] | null>>()
}))
vi.mock('../../../providers/execution-host-provider-dispatch', async (original) => ({
  ...(await original<typeof ProviderDispatch>()),
  resolveGitRouteForHost: () => ({ kind: 'local', createProvider: () => ({ exec: rootQuery }) })
}))
beforeEach(() => rootQuery.mockResolvedValue({ stdout: 'false' }))
vi.mock('../../../orcad/orcad-terminal-census', () => ({ collectOrcadTerminalCensus: collect }))
vi.mock('../../../daemon/providers/lifecycle/daemon-provider-state', () => ({
  listLiveDaemonPtyIds
}))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, store } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
const target = spawnWorktreeTarget(TEST_WORKTREE_ID, null)

type CensusRequest = Omit<z.input<typeof OrcadTerminalCensusParamsSchema>, 'activatedAt'>

function census(runtime: InstanceType<typeof OrcaRuntimeService>, params: CensusRequest) {
  // Parsed as the server parses it, so a field the server does not know is dropped here too.
  const parsed = OrcadTerminalCensusParamsSchema.parse({ activatedAt: 1, ...params })
  return ORCAD_TERMINAL_CENSUS_METHODS[0]!.handler(parsed, { runtime })
}

// What the SSH and WSL updates send as the last count before the stop.
const updateRecount: CensusRequest = {
  releaseFinishedAutomationTerminals: true,
  closeAdmissionForMs: ORCAD_UPDATE_ADMISSION_FENCE_MS
}

afterEach(() => {
  vi.useRealTimers()
  collect.mockReset()
  listLiveDaemonPtyIds.mockReset()
})

describe("an update's last terminal census", () => {
  it('counts only after a spawn admitted before it has finished starting', async () => {
    collect.mockResolvedValue({ ...idle, liveSessions: 1 })
    const runtime = new OrcaRuntimeService(store)
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(target)

    const counted = census(runtime, updateRecount)
    await vi.waitFor(() => expect(runtime.terminalUpdateAdmission.isClosed()).toBe(true))
    expect(collect).not.toHaveBeenCalled()
    releaseSpawn()

    await expect(counted).resolves.toMatchObject({ liveSessions: 1 })
  })

  it('still lets a client reattach a session the daemon runs, but not one it cannot vouch for', async () => {
    collect.mockResolvedValue({ ...idle, liveSessions: 1 })
    const runtime = new OrcaRuntimeService(store)
    await census(runtime, updateRecount)

    listLiveDaemonPtyIds.mockResolvedValue(['pty-live'])
    const requireAttachOnly = vi.fn()
    const release = await runtime.acquireWorktreeTerminalSpawn(target, {
      reattachSessionId: 'pty-live',
      requireAttachOnly
    })
    release()
    // Should the session exit before the attach lands, the spawn fails instead of starting one.
    expect(requireAttachOnly).toHaveBeenCalledTimes(1)
    listLiveDaemonPtyIds.mockResolvedValue(null)
    await expect(
      runtime.acquireWorktreeTerminalSpawn(target, { reattachSessionId: 'pty-live' })
    ).rejects.toThrow(TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE)
  })
})

describe('bare storage terminal admission', () => {
  it('refuses fresh creation and cannot recreate a saved session that exited before attachment', async () => {
    rootQuery.mockResolvedValue({ stdout: 'true' })
    const runtime = new OrcaRuntimeService(store)
    await expect(runtime.acquireWorktreeTerminalSpawn(target)).rejects.toThrow(
      'This folder contains Git storage'
    )
    const spawnSubprocess = vi.fn(() => {
      throw new Error('must not create')
    })
    const host = new TerminalHost({ spawnSubprocess })
    let attachOnly = false
    const release = await runtime.acquireWorktreeTerminalSpawn(target, {
      reattachSessionId: 'exited-pane',
      requireAttachOnly: () => {
        attachOnly = true
      }
    })
    try {
      await expect(
        host.createOrAttach({
          sessionId: 'exited-pane',
          cols: 80,
          rows: 24,
          attachOnly,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).rejects.toThrow('Session not found: exited-pane')
      expect(spawnSubprocess).not.toHaveBeenCalled()
    } finally {
      release()
      await host.dispose()
    }
  })
})

it('launch classification never starts or waits for full scans at fleet scale', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1700000000000)
  const runtime = new OrcaRuntimeService(store)
  const repo = store.getRepos()[0]!
  const key = `${repo.id}\0local`
  const scan = vi.spyOn(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spy observes the existing protected runtime method without changing its implementation.
    runtime as unknown as { listRepoWorktreesForResolution: (...args: unknown[]) => unknown },
    'listRepoWorktreesForResolution'
  )
  const metadata = vi.spyOn(store, 'getAllWorktreeMeta')
  for (const population of [750, 7500]) {
    const graph = Array.from({ length: population }, (_, index) => ({
      path: `/fleet/${index}`,
      head: 'abc',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }))
    graph[0]!.path = TEST_WORKTREE_ID.slice(TEST_WORKTREE_ID.indexOf('::') + 2)
    const cached = {
      generation: 0,
      runtimeKey: resolveWorktreeScanRuntime({ ...store, getSettings: () => ({}) }, repo)
        .runtimeKey,
      result: { ok: true as const, worktrees: graph },
      expiresAt: 1700000030000,
      scannedAt: 1700000000000,
      adminFingerprint: null
    }
    runtime['worktreeScanCache'].set(key, cached)
    rootQuery.mockClear()
    const panes = population === 750 ? 100 : 1000
    for (let index = 0; index < panes; index++) {
      const release = await runtime.acquireWorktreeTerminalSpawn(target)
      release()
    }
    expect(rootQuery).not.toHaveBeenCalled()
    cached.expiresAt = 0
    runtime['worktreeScanInFlight'].set(key, {
      generation: 0,
      runtimeKey: cached.runtimeKey,
      promise: new Promise(() => {})
    })
    const releases = await Promise.all(
      Array.from({ length: panes }, () => runtime.acquireWorktreeTerminalSpawn(target))
    )
    releases.forEach((release) => release())
    expect(rootQuery).toHaveBeenCalledTimes(1)
    rootQuery.mockClear()
    runtime['worktreeScanGenerations'].set(key, 1)
    for (let index = 0; index < panes; index++) {
      const release = await runtime.acquireWorktreeTerminalSpawn(target)
      release()
    }
    expect(rootQuery).toHaveBeenCalledTimes(panes)
    runtime['worktreeScanGenerations'].clear()
    runtime['worktreeScanInFlight'].clear()
  }
  rootQuery.mockResolvedValue({ stdout: 'true' })
  await expect(runtime.acquireWorktreeTerminalSpawn(target)).rejects.toThrow(
    'This folder contains Git storage'
  )
  expect(scan).not.toHaveBeenCalled()
  expect(metadata).not.toHaveBeenCalled()
  scan.mockRestore()
  metadata.mockRestore()
})
