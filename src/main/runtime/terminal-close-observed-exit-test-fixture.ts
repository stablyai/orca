import { capturePtyStopExpectation } from '../ipc/pty/runtime/stop-publication'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { rmSync } from 'node:fs'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import {
  createMockSubprocess,
  startDaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'
import { startLateExitHarness } from '../ipc/pty/daemon-late-exit-test-fixture'
import { bindProviderListeners } from '../ipc/pty/provider/bind-listeners'
import { finishPtyShutdown } from '../ipc/pty/provider/liveness'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../ipc/pty/provider/registry'
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
      kill: (id, opts) => killPtyFromRuntimeController(deps, id, opts),
      stopAndWait: (id, opts) =>
        stopAndWaitPtyFromRuntimeController(deps, id, { ...opts, deadlineMs: Date.now() + 1_500 })
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
  async closeControl(): Promise<boolean> {
    return (
      await this.stopExplicitlyClosedTabPtys(
        this.captureExplicitCloseTargets([CONTROL_PTY_ID], {
          worktreeId: WORKTREE_ID,
          tabId: BINDING.tabId
        }),
        CONTROL_PTY_ID
      )
    ).stopped
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
  runtime.registerPty(CONTROL_PTY_ID, WORKTREE_ID, null, {
    ...BINDING,
    ...(original ? { incarnationId: original } : {})
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
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
      verdict: runtime.getPtyLivenessVerdict(CONTROL_PTY_ID)
    }
  } finally {
    runtime.onPtyExit(CONTROL_PTY_ID, 0, control === 'replacement' ? NEXT_INCARNATION : original)
  }
}

export async function runExplicitCloseProviderReplacement(
  timing:
    | 'before-capture'
    | 'after-capture'
    | 'initial-mismatch-disappears'
    | 'matching-after-capture'
) {
  const runtime = new ObservedExitRuntime()
  runtime.registerPty(CONTROL_PTY_ID, WORKTREE_ID, null, {
    ...BINDING,
    incarnationId: FIRST_INCARNATION
  })
  const provider = getLocalPtyProvider()
  const startup = Promise.withResolvers<void>()
  let resourceStopped = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller calls only shutdown/listProcesses on this fake provider.
  setLocalPtyProvider({
    shutdown: async () => {
      resourceStopped = true
    },
    listProcesses: async () => [{ id: CONTROL_PTY_ID }]
  } as unknown as IPtyProvider)
  const ports = {
    runtime,
    getLocalPtyProviderStartupPromise: () => startup.promise,
    shutdownProviderAndDetectExit: async (selected: IPtyProvider, id: string) => {
      await selected.shutdown(id, { immediate: true })
      return false
    },
    finishPtyShutdown,
    retiredRejectedPtyIds: new Map<string, NodeJS.Timeout>(),
    rememberSyntheticKillExit: () => {},
    sendPtyExitToRenderer: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this close calls only the stop ports above.
  const deps = ports as unknown as PtyRuntimeControllerDeps
  ptyOwnership.set(CONTROL_PTY_ID, 'local')
  ptyIncarnationById.set(CONTROL_PTY_ID, FIRST_INCARNATION)
  runtime.setPtyController({
    write: () => true,
    getForegroundProcess: async () => null,
    captureStopExpectation: capturePtyStopExpectation,
    stopAndWait: (id, opts) => stopAndWaitPtyFromRuntimeController(deps, id, opts),
    kill: (id, opts) => killPtyFromRuntimeController(deps, id, opts)
  })
  try {
    if (timing === 'before-capture' || timing === 'initial-mismatch-disappears') {
      ptyIncarnationById.set(CONTROL_PTY_ID, NEXT_INCARNATION)
    } else if (timing === 'matching-after-capture') {
      ptyIncarnationById.delete(CONTROL_PTY_ID)
    }
    const close = runtime.closeControl()
    // Provider reconciliation precedes the async pane save/runtime registration.
    if (timing === 'initial-mismatch-disappears') {
      ptyIncarnationById.delete(CONTROL_PTY_ID)
    } else {
      ptyIncarnationById.set(
        CONTROL_PTY_ID,
        timing === 'matching-after-capture' ? FIRST_INCARNATION : NEXT_INCARNATION
      )
    }
    startup.resolve()
    const stopped = await close
    await Promise.resolve()
    return { stopped, resourceStopped }
  } finally {
    ptyOwnership.delete(CONTROL_PTY_ID)
    ptyIncarnationById.delete(CONTROL_PTY_ID)
    setLocalPtyProvider(provider)
  }
}
