// An update counts the server's terminals, then stops it: a terminal started between the two
// would die with the stop, uncounted. The last census closes admission so none can start.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  OrcadTerminalCensusParamsSchema
} from '../../shared/orcad-terminal-census'
import { spawnWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { ORCAD_TERMINAL_CENSUS_METHODS } from './rpc/methods/orcad-terminal-census'
import { TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE } from './terminal/stop/terminal-update-admission'

const { collect, listLiveDaemonPtyIds } = vi.hoisted(() => ({
  collect: vi.fn(),
  listLiveDaemonPtyIds: vi.fn<() => Promise<string[] | null>>()
}))
vi.mock('../orcad/orcad-terminal-census', () => ({ collectOrcadTerminalCensus: collect }))
vi.mock('../daemon/daemon-provider-state', () => ({ listLiveDaemonPtyIds }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, store } = await import('./orca-runtime-test-fixtures.spec')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
const target = spawnWorktreeTarget(TEST_WORKTREE_ID, null)

type CensusRequest = Omit<z.input<typeof OrcadTerminalCensusParamsSchema>, 'activatedAt'>

function census(runtime: InstanceType<typeof OrcaRuntimeService>, params: CensusRequest) {
  // Parsed as the server parses it, so a field the server does not know is dropped here too.
  const parsed = OrcadTerminalCensusParamsSchema.parse({ activatedAt: 1, ...params })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only `runtime` from its context.
  return ORCAD_TERMINAL_CENSUS_METHODS[0]!.handler(parsed, { runtime } as never)
}

// What the SSH and WSL updates send as the last count before the stop.
const updateRecount: CensusRequest = {
  releaseFinishedAutomationTerminals: true,
  closeAdmissionForMs: ORCAD_UPDATE_ADMISSION_FENCE_MS
}

afterEach(() => {
  collect.mockReset()
  listLiveDaemonPtyIds.mockReset()
})

describe("an update's last terminal census", () => {
  it('refuses every new terminal until the stop, with a retryable message', async () => {
    collect.mockResolvedValue(idle)
    const runtime = new OrcaRuntimeService(store)
    await expect(census(runtime, updateRecount)).resolves.toMatchObject({
      liveSessions: 0,
      admissionClosedUntil: expect.any(Number)
    })

    await expect(runtime.acquireWorktreeTerminalSpawn(target)).rejects.toThrow(
      TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE
    )
    // A spawn outside any worktree dies with the stop all the same.
    await expect(runtime.acquireWorktreeTerminalSpawn(undefined)).rejects.toThrow(
      TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE
    )
  })

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

  it('reopens admission when a deferred update asks with 0, and a plain census never closes it', async () => {
    collect.mockResolvedValue(idle)
    const runtime = new OrcaRuntimeService(store)
    await expect(census(runtime, { releaseFinishedAutomationTerminals: true })).resolves.toEqual(
      idle
    )
    ;(await runtime.acquireWorktreeTerminalSpawn(target))()

    await census(runtime, updateRecount)
    await expect(census(runtime, { closeAdmissionForMs: 0 })).resolves.toMatchObject({
      admissionClosedUntil: 0
    })
    ;(await runtime.acquireWorktreeTerminalSpawn(target))()
  })
})
