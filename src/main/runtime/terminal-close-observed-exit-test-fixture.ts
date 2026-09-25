import { rmSync } from 'node:fs'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import {
  createMockSubprocess,
  startDaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'
import { startLateExitHarness } from '../ipc/pty/daemon-late-exit-test-fixture'
import { bindProviderListeners } from '../ipc/pty/provider/bind-listeners'
import { finishPtyShutdown } from '../ipc/pty/provider/liveness'
import { setLocalPtyProvider } from '../ipc/pty/provider/registry'
import { shutdownProviderAndDetectExit } from '../ipc/pty/provider/shutdown-detect'
import type { PtyRuntimeControllerDeps } from '../ipc/pty/runtime/controller-deps'
import {
  killPtyFromRuntimeController,
  stopAndWaitPtyFromRuntimeController
} from '../ipc/pty/runtime/kill'
import { OrcaRuntimeService } from './orca-runtime'

export type ObservedExitSocketScenario =
  | 'healthy'
  | 'unrelated-endpoint-gone'
  | 'physical-exit-observed'

export async function runObservedExitSocketScenario(scenario: ObservedExitSocketScenario) {
  const harness = await startLateExitHarness()
  const legacy = await startDaemonAdapterHarness(() => createMockSubprocess())
  const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [legacy.adapter] })
  let fallbackKills = 0
  try {
    await router.discoverLegacySessions()
    setLocalPtyProvider(router)
    bindProviderListeners(harness.session)
    const ports = {
      runtime: harness.runtime,
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit,
      rememberSyntheticKillExit: harness.session.rememberSyntheticKillExit,
      sendPtyExitToRenderer: harness.session.sendPtyExitToRenderer,
      finishPtyShutdown,
      retiredRejectedPtyIds: new Map<string, NodeJS.Timeout>()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stop/kill read only these controller ports and optional store; spawn ports are unused.
    const deps = ports as unknown as PtyRuntimeControllerDeps
    harness.runtime.setPtyController({
      write: () => true,
      getForegroundProcess: async () => null,
      kill: (id) => {
        fallbackKills++
        return killPtyFromRuntimeController(deps, id)
      },
      stopAndWait: (id) =>
        stopAndWaitPtyFromRuntimeController(deps, id, { deadlineMs: Date.now() + 1_500 })
    })
    const list = await harness.runtime.listTerminals()
    const terminal = list.terminals.find((entry) => entry.ptyId === harness.id)
    if (!terminal) {
      throw new Error('Fixture terminal missing')
    }
    if (scenario !== 'healthy') {
      await legacy.server.shutdown()
    }
    if (scenario !== 'physical-exit-observed') {
      harness.pauseStream()
    }
    const close = await harness.runtime.closeTerminal(terminal.handle)
    const targetInventory = await harness.adapter.listProcesses()
    const targetProbe = await harness.adapter.probePtyLiveness(harness.id)
    const routerProbe = await router.probePtyLiveness(harness.id)
    const beforeStreamResume = await harness.capture()
    harness.resumeStream()
    await harness.waitForExit()
    const settled = await harness.capture()
    return {
      scenario,
      close: {
        ptyKilled: close.ptyKilled,
        ptyStopVerdict: close.ptyStopVerdict ?? null
      },
      fallbackKills,
      targetInventoryCount: targetInventory.length,
      targetProbe,
      routerProbe,
      beforeStreamResume,
      settled
    }
  } finally {
    router.disposeRouterOnly()
    await harness.dispose()
    legacy.adapter.dispose()
    await legacy.server.shutdown()
    rmSync(legacy.dir, { recursive: true, force: true })
  }
}

const CONTROL_PTY_ID = 'repo::/tmp/observed-exit-control@@pty'
const WORKTREE_ID = 'repo::/tmp/observed-exit-control'
const FIRST_INCARNATION = '10000000-0000-4000-8000-000000000001'
const NEXT_INCARNATION = '10000000-0000-4000-8000-000000000002'
const BINDING = {
  tabId: 'control-tab',
  leafId: '10000000-0000-4000-8000-000000000004'
}

class ObservedExitRuntime extends OrcaRuntimeService {
  closeControl(): Promise<boolean> {
    return this.stopExplicitlyClosedTabPtys([CONTROL_PTY_ID], CONTROL_PTY_ID)
  }
}

export type ObservedExitControl =
  | 'same-incarnation'
  | 'replacement'
  | 'unverified'
  | 'legacy-unstamped'
  | 'throw-after-exit'

export async function runObservedExitControl(control: ObservedExitControl) {
  const runtime = new ObservedExitRuntime()
  const original = control === 'legacy-unstamped' ? undefined : FIRST_INCARNATION
  let fallbackKills = 0
  runtime.registerPty(CONTROL_PTY_ID, WORKTREE_ID, null, {
    ...BINDING,
    ...(original ? { incarnationId: original } : {})
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => {
      fallbackKills++
      return true
    },
    getForegroundProcess: async () => null,
    stopAndWait: async () => {
      runtime.onPtyExit(CONTROL_PTY_ID, control === 'unverified' ? -1 : 0, original)
      if (control === 'replacement') {
        runtime.registerPty(CONTROL_PTY_ID, WORKTREE_ID, null, {
          ...BINDING,
          incarnationId: NEXT_INCARNATION
        })
      }
      if (control === 'throw-after-exit') {
        throw new Error('unverified transport failure')
      }
      return false
    }
  })
  try {
    const stopped = await runtime.closeControl()
    return {
      scenario: control,
      stopped,
      fallbackKills,
      verdict: runtime.getPtyLivenessVerdict(CONTROL_PTY_ID)
    }
  } finally {
    runtime.onPtyExit(CONTROL_PTY_ID, 0, control === 'replacement' ? NEXT_INCARNATION : original)
  }
}
