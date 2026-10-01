import type { BrowserWindow } from 'electron'
import { Socket } from 'node:net'
import { rmSync } from 'node:fs'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from '../../daemon/daemon-pty-adapter-test-harness'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { setPtyHostBindings, type PtyIpcSurface } from '../pty-host-bindings'
import { consumeSyntheticKillExit, rememberSyntheticKillExit } from './delivery/exit'
import { installPtyKillIpcHandler } from './ipc/renderer-kill'
import { bindProviderListeners } from './provider/bind-listeners'
import { ptyIncarnationById, ptyOwnership } from './provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from './provider/registry'
import { unbindLocalProviderListeners } from './provider/listener-lifecycle'
import { shutdownProviderAndDetectExit } from './provider/shutdown-detect'
import { finishPtyShutdown } from './provider/liveness'
import { stopAndWaitPtyFromRuntimeController } from './runtime/kill'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import { createPtyIpcSession } from './session'
import type { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'

const PTY_ID = 'repo::/tmp/late-exit-audit@@terminal'
const TAB_ID = '00000000-0000-4000-8000-000000000001'
const LEAF_ID = '00000000-0000-4000-8000-000000000002'

class LateExitRuntime extends OrcaRuntimeService {
  observeExit(listener: () => void): void {
    this.ptyExitListenersByPtyId.set(PTY_ID, new Set([listener]))
  }

  captureState() {
    const pty = this.ptysById.get(PTY_ID)
    return {
      connected: pty?.connected,
      exitCause: pty?.lastExitCause,
      incarnationId: pty?.incarnationId,
      headlessModelRetained: this.headlessTerminals.has(PTY_ID),
      titleTrackerRetained: this.ptyTitleTrackersByPtyId.has(PTY_ID),
      liveness: this.ptyLivenessVerdictByPtyId.get(PTY_ID)?.verdict.status ?? null
    }
  }
}

function adapterStreamSocket(adapter: DaemonPtyAdapter): Socket {
  const socket = adapter['client']['streamSocket']
  if (!(socket instanceof Socket)) {
    throw new Error('Daemon stream socket missing')
  }
  return socket
}

export async function startLateExitHarness() {
  let subprocess = createMockSubprocess()
  const harness = await startDaemonAdapterHarness(() => {
    subprocess = createMockSubprocess()
    return subprocess
  })
  const runtime = new LateExitRuntime()
  const priorProvider = getLocalPtyProvider()
  const deliveredData: string[] = []
  const rendererExits: { id: string; code: number; incarnationId?: string }[] = []
  const providerExits: { id: string; code: number; incarnationId?: string }[] = []
  let exitListenerCalls = 0
  const windowStub = { isDestroyed: () => false, webContents: { send() {} } }
  const session = createPtyIpcSession({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provider listeners only inspect isDestroyed and webContents.send on this headless fixture.
    mainWindow: windowStub as unknown as BrowserWindow,
    runtime
  })
  session.acceptPtyDataForRenderer = (event) => {
    deliveredData.push(event.data)
  }
  session.sendPtyExitToRenderer = (event) => {
    rendererExits.push(event)
  }
  session.consumeSyntheticKillExit = (id, incarnationId) =>
    consumeSyntheticKillExit(session, id, incarnationId)
  session.rememberSyntheticKillExit = (id, incarnationId) =>
    rememberSyntheticKillExit(session, id, incarnationId)
  session.sendModelRestoreNeededMarker = () => false
  let killHandler: Parameters<PtyIpcSurface['handle']>[1] | undefined
  setLocalPtyProvider(harness.adapter)
  bindProviderListeners(session)
  setPtyHostBindings({
    ipc: {
      handle: (channel, handler) => {
        if (channel === 'pty:kill') {
          killHandler = handler
        }
      },
      on() {},
      removeHandler() {},
      removeAllListeners() {}
    }
  })
  installPtyKillIpcHandler({
    runtime,
    getLocalPtyProviderStartupPromise: () => undefined,
    shutdownProviderAndDetectExit,
    rememberSyntheticKillExit: session.rememberSyntheticKillExit,
    sendPtyExitToRenderer: session.sendPtyExitToRenderer
  })
  const result = await harness.adapter.spawn({ cols: 80, rows: 24, sessionId: PTY_ID })
  ptyOwnership.set(PTY_ID, null)
  if (result.incarnationId) {
    ptyIncarnationById.set(PTY_ID, result.incarnationId)
  }
  runtime.registerPty(PTY_ID, 'repo::/tmp/late-exit-audit', null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: result.incarnationId
  })
  runtime.observeExit(() => {
    exitListenerCalls++
  })
  harness.adapter.onExit((event) => {
    providerExits.push(event)
  })
  const streamSocket = adapterStreamSocket(harness.adapter)
  return {
    ...harness,
    runtime,
    session,
    result,
    deliveredData,
    rendererExits,
    providerExits,
    get subprocess() {
      return subprocess
    },
    respawn: async () => {
      harness.adapter.clearTombstone(PTY_ID)
      const replacement = await harness.adapter.spawn({ cols: 80, rows: 24, sessionId: PTY_ID })
      ptyOwnership.set(PTY_ID, null)
      if (replacement.incarnationId) {
        ptyIncarnationById.set(PTY_ID, replacement.incarnationId)
      }
      runtime.registerPty(PTY_ID, 'repo::/tmp/late-exit-audit', null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: replacement.incarnationId
      })
      runtime.observeExit(() => {
        exitListenerCalls++
      })
      return replacement
    },
    id: PTY_ID,
    deliverProviderExit: (event: { id: string; code: number; incarnationId?: string }) => {
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: exit listeners may unsubscribe while receiving the event.
      for (const listener of [...harness.adapter['exitListeners']]) {
        listener(event)
      }
    },
    pauseStream: () => {
      streamSocket.pause()
    },
    resumeStream: () => {
      streamSocket.resume()
    },
    kill: async () => {
      if (!killHandler) {
        throw new Error('PTY kill handler missing')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installed renderer-kill handler ignores its Electron event argument.
      await killHandler({} as never, { id: PTY_ID })
    },
    stopAndWait: () => {
      const deps = {
        runtime,
        getLocalPtyProviderStartupPromise: () => undefined,
        shutdownProviderAndDetectExit,
        rememberSyntheticKillExit: session.rememberSyntheticKillExit,
        sendPtyExitToRenderer: session.sendPtyExitToRenderer,
        finishPtyShutdown
      }
      return stopAndWaitPtyFromRuntimeController(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exact-stop reads only these seven controller ports and optional store; unrelated spawn ports are unused.
        deps as unknown as PtyRuntimeControllerDeps,
        PTY_ID
      )
    },
    waitForExit: () => waitFor(() => providerExits.length > 0),
    capture: async () => ({
      ...runtime.captureState(),
      providerHasPty: harness.adapter.hasPty(PTY_ID),
      hostInventoryCount: (await harness.adapter.listProcesses()).length,
      deliveredData: [...deliveredData],
      rendererExitCount: rendererExits.length,
      providerExitCount: providerExits.length,
      exitListenerCalls
    }),
    dispose: async () => {
      for (const pending of session.syntheticKillExitPtyIds.values()) {
        clearTimeout(pending.cleanupTimer)
      }
      session.syntheticKillExitPtyIds.clear()
      runtime.onPtyExit(PTY_ID, 0, runtime.captureState().incarnationId ?? undefined)
      unbindLocalProviderListeners()
      harness.adapter.dispose()
      await harness.server.shutdown()
      setLocalPtyProvider(priorProvider)
      setPtyHostBindings({})
      ptyOwnership.delete(PTY_ID)
      ptyIncarnationById.delete(PTY_ID)
      rmSync(harness.dir, { recursive: true, force: true })
    }
  }
}
