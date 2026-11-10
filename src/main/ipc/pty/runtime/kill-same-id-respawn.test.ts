import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { stopRendererOwnedPty, type PtyKillIpcDeps } from '../ipc/renderer-kill'
import { finishPtyShutdown } from '../provider/liveness'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { stopAndWaitPtyFromRuntimeController } from './kill'

const PTY_ID = 'respawned-pty'

function providerWhose(duringShutdown: () => void, listed: { id: string }[]): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stops call only shutdown and listProcesses.
  return {
    shutdown: async () => duringShutdown(),
    listProcesses: async () => listed
  } as unknown as IPtyProvider
}

function harness() {
  const runtime = {
    markPtyStopRequested: vi.fn(),
    markPtyLivenessUnverifiable: vi.fn(),
    markPtyLivenessLive: vi.fn(),
    onPtyExit: vi.fn()
  }
  const ports = {
    runtime,
    getLocalPtyProviderStartupPromise: () => undefined,
    shutdownProviderAndDetectExit: async (provider: IPtyProvider, id: string) => {
      await provider.shutdown(id, { immediate: true })
      return false
    },
    rememberSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer: vi.fn(),
    finishPtyShutdown,
    retiredRejectedPtyIds: new Map<string, NodeJS.Timeout>()
  }
  return { runtime, ports }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stops read only these ports and an optional store.
const asControllerDeps = (ports: unknown) => ports as PtyRuntimeControllerDeps
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tab-close stop reads only these ports and an optional store.
const asKillIpcDeps = (ports: unknown) => ports as PtyKillIpcDeps

const original = getLocalPtyProvider()
afterEach(() => {
  setLocalPtyProvider(original)
  ptyOwnership.delete(PTY_ID)
  ptyIncarnationById.delete(PTY_ID)
})

describe('a stop whose shutdown lands after a same-id respawn', () => {
  function respawn(): void {
    ptyOwnership.set(PTY_ID, LOCAL_EXECUTION_HOST_ID)
    ptyIncarnationById.set(PTY_ID, 'inc-respawn')
  }
  function start(): ReturnType<typeof harness> {
    setLocalPtyProvider(providerWhose(respawn, [{ id: PTY_ID }]))
    ptyOwnership.set(PTY_ID, LOCAL_EXECUTION_HOST_ID)
    ptyIncarnationById.set(PTY_ID, 'inc-stopped')
    return harness()
  }

  function expectRespawnUntouched({ runtime, ports }: ReturnType<typeof harness>): void {
    expect(ptyOwnership.get(PTY_ID)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-respawn')
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(ports.sendPtyExitToRenderer).not.toHaveBeenCalled()
  }

  it('reports the listed respawn live after a stop-and-wait', async () => {
    const h = start()
    await expect(
      stopAndWaitPtyFromRuntimeController(asControllerDeps(h.ports), PTY_ID)
    ).resolves.toBe(false)
    expect(h.runtime.markPtyLivenessLive).toHaveBeenCalledWith(PTY_ID)
    expectRespawnUntouched(h)
  })

  it('leaves the respawn alone after a renderer tab close', async () => {
    const h = start()
    await stopRendererOwnedPty(asKillIpcDeps(h.ports), { id: PTY_ID })
    expectRespawnUntouched(h)
  })
})

describe('a stop of a PTY whose incarnation was stamped mid-stop', () => {
  // Owner reconciliation can discover this same process's incarnation while shutdown is pending.
  function start(): ReturnType<typeof harness> {
    setLocalPtyProvider(providerWhose(() => ptyIncarnationById.set(PTY_ID, 'inc-same'), []))
    ptyOwnership.set(PTY_ID, LOCAL_EXECUTION_HOST_ID)
    return harness()
  }

  function expectRetired({ ports }: ReturnType<typeof harness>): void {
    expect(ptyOwnership.has(PTY_ID)).toBe(false)
    expect(ports.sendPtyExitToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ id: PTY_ID })
    )
  }

  it('retires it after a renderer tab close', async () => {
    const h = start()
    await stopRendererOwnedPty(asKillIpcDeps(h.ports), { id: PTY_ID })
    expectRetired(h)
  })
})

describe('a slept pane conditional stop', () => {
  function conditionalHarness() {
    const h = harness()
    const inspection = vi.fn(async () => ({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      foregroundObservation: {
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude',
        ptyId: PTY_ID,
        ptyIncarnationId: 'inc-stopped',
        authorityGeneration: 'authority-1',
        capturedAgeMs: 0,
        observationEpoch: 1
      }
    }))
    const provider = Object.assign(
      providerWhose(() => {}, []),
      { inspectProcess: inspection }
    )
    const shutdown = vi.fn(h.ports.shutdownProviderAndDetectExit)
    const current = vi.fn(() => true)
    const ports = {
      ...h.ports,
      shutdownProviderAndDetectExit: shutdown,
      runtime: {
        ...h.runtime,
        paneSleepStopIsCurrent: current,
        runWorktreeTerminalMutation: async (_workspace: string, run: () => Promise<void>) => run()
      }
    }
    ptyOwnership.set(PTY_ID, LOCAL_EXECUTION_HOST_ID)
    ptyIncarnationById.set(PTY_ID, 'inc-stopped')
    setLocalPtyProvider(provider)
    const condition = {
      workspace: 'repo::/sleep',
      target: {
        paneKey: 'tab:leaf',
        ptyId: PTY_ID,
        ptyIncarnationId: 'inc-stopped',
        authorityGeneration: 'authority-1',
        sourceUpdatedAt: 1
      }
    }
    return { ports, shutdown, current, inspection, condition }
  }
  it('checks the process again after provider startup and never stops a replacement', async () => {
    const h = conditionalHarness()
    h.ports.getLocalPtyProviderStartupPromise = () => {
      ptyIncarnationById.set(PTY_ID, 'inc-replacement')
      return undefined
    }
    await expect(
      stopRendererOwnedPty(asKillIpcDeps(h.ports), {
        id: PTY_ID,
        keepHistory: true,
        sleepCondition: h.condition
      })
    ).rejects.toThrow('sleep_target_changed')
    expect(h.shutdown).not.toHaveBeenCalled()
    expect(h.ports.runtime.markPtyStopRequested).not.toHaveBeenCalled()
    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-replacement')
  })
  it('does not stop a same-process successor that retired the staged capture', async () => {
    const h = conditionalHarness()
    h.current.mockReturnValue(false)
    await expect(
      stopRendererOwnedPty(asKillIpcDeps(h.ports), {
        id: PTY_ID,
        keepHistory: true,
        sleepCondition: h.condition
      })
    ).rejects.toThrow('sleep_target_changed')
    expect(h.shutdown).not.toHaveBeenCalled()
    expect(h.ports.runtime.markPtyStopRequested).not.toHaveBeenCalled()
  })
  it('keeps terminal history when the exact pane still admits its stop', async () => {
    const h = conditionalHarness()
    await stopRendererOwnedPty(asKillIpcDeps(h.ports), {
      id: PTY_ID,
      keepHistory: true,
      sleepCondition: h.condition
    })
    expect(h.shutdown).toHaveBeenCalledWith(expect.anything(), PTY_ID, {
      immediate: true,
      keepHistory: true
    })
    expect(h.ports.sendPtyExitToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ id: PTY_ID, incarnationId: 'inc-stopped' })
    )
  })
})
