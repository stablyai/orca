import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  RuntimeBrowserDriverState,
  RuntimeRendererSyncWindowGraph,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import { TERMINAL_FIT_RESTORE_DEADLINE_MS } from '../../shared/terminal-fit-restore-deadline'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { DesktopRuntimeSenderLifecycle } from './desktop-runtime-sender-lifecycle'
import { publishMobileProjectSections } from '../runtime/mobile-project-sections-snapshot'

function boundTerminalFitRestore(pending: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), TERMINAL_FIT_RESTORE_DEADLINE_MS)
    timer.unref?.()
  })
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer))
}

export function registerRuntimeHandlers(runtime: OrcaRuntimeService): void {
  const pendingTerminalFitRestores = new Map<string, Promise<boolean>>()
  const desktopSenders = new DesktopRuntimeSenderLifecycle(runtime)
  ipcMain.removeHandler('runtime:syncWindowGraph')
  ipcMain.removeHandler('runtime:getStatus')
  ipcMain.removeHandler('runtime:call')
  ipcMain.removeHandler('runtime:subscribe')
  ipcMain.removeAllListeners('runtime:unsubscribe')

  ipcMain.handle(
    'runtime:syncWindowGraph',
    (event, graph: RuntimeRendererSyncWindowGraph): RuntimeSyncWindowGraphResult => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error('Runtime graph sync must originate from a BrowserWindow')
      }
      if (event.senderFrame !== event.sender.mainFrame) {
        // Queued calls from a disposed frame must not settle the replacement document's generation.
        throw new Error('Runtime graph sync must originate from the current main frame')
      }
      if (typeof graph.rendererGeneration !== 'string' || graph.rendererGeneration.length === 0) {
        throw new Error('Runtime graph sync requires a renderer generation')
      }
      const result = runtime.syncWindowGraph(window.id, graph)
      // Only the authoritative window's accepted graph may publish its project catalog.
      if (graph.projectSectionCatalog) {
        publishMobileProjectSections(graph.projectSectionCatalog)
      }
      return result
    }
  )

  ipcMain.handle('runtime:getStatus', async (): Promise<RuntimeStatus> => {
    // Match status.get's capped name wait; later reads pick up a lookup that is still running.
    await runtime.machineNameReady()
    return runtime.getStatus()
  })

  ipcMain.handle(
    'runtime:call',
    async (
      event,
      args: { method: string; params?: unknown }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Runtime RPC call must originate from the current main frame')
      }
      return new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS }).dispatch(
        {
          id: 'desktop-ipc',
          authToken: 'desktop-ipc',
          method: args.method,
          params: args.params
        },
        {
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId: desktopSenders.connectionIdFor(event.sender),
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      )
    }
  )

  ipcMain.handle(
    'runtime:subscribe',
    (
      event,
      args: { subscriptionId: string; method: string; params?: unknown }
    ): { subscribed: boolean } => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Runtime subscription must originate from the current main frame')
      }
      const senderSubscriptions = desktopSenders.subscriptionsFor(event.sender)
      const connectionId = desktopSenders.connectionIdFor(event.sender)
      const previous = senderSubscriptions.get(args.subscriptionId)
      previous?.abort()
      const controller = new AbortController()
      senderSubscriptions.set(args.subscriptionId, controller)
      const channel = `runtime:subscription:${args.subscriptionId}`
      // Streaming outlives dispatch setup; unsubscribe or sender retirement owns cancellation.
      void new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS }).dispatchStreaming(
        {
          id: args.subscriptionId,
          authToken: 'desktop-ipc',
          method: args.method,
          params: args.params
        },
        (response) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) {
            event.sender.send(channel, JSON.parse(response) as RuntimeRpcResponse<unknown>)
          }
        },
        {
          signal: controller.signal,
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId,
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      )
      return { subscribed: true }
    }
  )

  ipcMain.on('runtime:unsubscribe', (event, args: { subscriptionId: string }) => {
    const senderSubscriptions = desktopSenders.existingSubscriptionsFor(event.sender)
    senderSubscriptions?.get(args.subscriptionId)?.abort()
    senderSubscriptions?.delete(args.subscriptionId)
  })

  ipcMain.removeHandler('runtime:getTerminalFitOverrides')
  ipcMain.handle(
    'runtime:getTerminalFitOverrides',
    (): {
      ptyId: string
      mode: 'mobile-fit' | 'remote-desktop-fit'
      cols: number
      rows: number
    }[] => {
      const overrides = runtime.getAllTerminalFitOverrides()
      return Array.from(overrides.entries()).map(([ptyId, override]) => ({
        ptyId,
        ...override
      }))
    }
  )

  ipcMain.removeHandler('runtime:getTerminalDrivers')
  ipcMain.handle(
    'runtime:getTerminalDrivers',
    (): { ptyId: string; driver: RuntimeTerminalDriverState }[] => {
      const drivers = runtime.getAllTerminalDrivers()
      return Array.from(drivers.entries()).map(([ptyId, driver]) => ({ ptyId, driver }))
    }
  )

  ipcMain.removeHandler('runtime:getBrowserDrivers')
  ipcMain.handle(
    'runtime:getBrowserDrivers',
    (): { browserPageId: string; driver: RuntimeBrowserDriverState }[] => {
      const drivers = runtime.getAllBrowserDrivers()
      return Array.from(drivers.entries()).map(([browserPageId, driver]) => ({
        browserPageId,
        driver
      }))
    }
  )

  ipcMain.removeHandler('runtime:getBrowserRemoteViewerPages')
  ipcMain.handle('runtime:getBrowserRemoteViewerPages', (): string[] =>
    runtime.getBrowserRemoteViewerPages()
  )

  // In-memory renderer rows need a main-owned source for reload restoration.
  ipcMain.removeHandler('runtime:getClientHostedBrowserRows')
  ipcMain.handle('runtime:getClientHostedBrowserRows', (): ClientHostedBrowserRowsEvent[] =>
    runtime.listClientHostedBrowserRows()
  )

  // Restore desktop dimensions through the mobile display-mode path so subscribers receive resize events.
  ipcMain.removeHandler('runtime:restoreTerminalFit')
  ipcMain.handle('runtime:restoreTerminalFit', async (_event, args: { ptyId: string }) => {
    // Take back input and sizing for desktop (docs/mobile-presence-lock.md).
    // Keep one reclaim per PTY through caller timeouts; retries cannot bypass layout serialization.
    let pending = pendingTerminalFitRestores.get(args.ptyId)
    if (!pending) {
      try {
        let tracked!: Promise<boolean>
        const clearTrackedRestore = (): void => {
          if (pendingTerminalFitRestores.get(args.ptyId) === tracked) {
            pendingTerminalFitRestores.delete(args.ptyId)
          }
        }
        tracked = runtime.reclaimTerminalForDesktop(args.ptyId).then(
          (restored) => {
            clearTrackedRestore()
            return restored
          },
          () => {
            clearTrackedRestore()
            return false
          }
        )
        pending = tracked
        pendingTerminalFitRestores.set(args.ptyId, pending)
      } catch {
        return { restored: false }
      }
    }
    return { restored: await boundTerminalFitRestore(pending) }
  })

  ipcMain.removeHandler('runtime:reclaimBrowserForDesktop')
  ipcMain.handle(
    'runtime:reclaimBrowserForDesktop',
    (_event, args: { browserPageId: string }): { reclaimed: boolean } => {
      try {
        return { reclaimed: runtime.reclaimBrowserForDesktop(args.browserPageId) }
      } catch {
        return { reclaimed: false }
      }
    }
  )
}
