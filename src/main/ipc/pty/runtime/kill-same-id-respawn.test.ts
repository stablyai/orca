import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'

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
})
