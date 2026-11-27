import { app, ipcMain, MessageChannelMain, utilityProcess, type WebContents } from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { BackendPortRpc } from '../../shared/backend/backend-port-rpc'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_REQUEST,
  BACKEND_UTILITY_PROCESS_NAME,
  type AutomationUsageClient
} from '../../shared/backend/backend-service-contract'
import { backendMessagePort } from '../backend/backend-message-port'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { ManagedOrcadEventWindow } from '../managed-server/lifecycle/orcad-managed-event-window'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from '../orcad/host-lifecycle/managed-stop/orcad-stop-deadlines'
import {
  BackendIdleStopTimer,
  createBackendDesktopCapabilities,
  handleBackendPortRequest,
  stopBackendUtilityChild,
  terminateBackendChild,
  type BackendDocument
} from './backend-desktop-capabilities'
import type { UsageWorktreeSource } from '../usage/worktree-attribution/usage-worktree-metadata'

export { captureBackendBootstrap } from './backend-bootstrap'
import { capturedBootstrap, sendBackendBootstrap } from './backend-bootstrap'

export class BackendSupervisor {
  private child: ReturnType<typeof utilityProcess.fork> | null = null
  private control: BackendPortRpc | null = null
  private ready: Promise<void> | null = null
  private disposeFailedStartup?: () => void
  private desiredRunning = true
  private exited: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readonly failures = new ManagedOrcadEventWindow(10 * 60_000, Date.now)
  private incarnation: string | undefined
  private readonly documents = new Map<number, BackendDocument>()
  private readonly idleStop = new BackendIdleStopTimer()
  private readonly idleRetired = new WeakSet<ReturnType<typeof utilityProcess.fork>>()
  private activeControlCalls = 0
  private stopping?: Promise<void>

  private readonly retireRenderer = (_event: unknown, contents: WebContents): void =>
    this.documents.get(contents.id)?.retire()

  constructor(private readonly store: UsageWorktreeSource) {
    if (!capturedBootstrap) {
      throw new Error('Backend paths were not captured during preflight.')
    }
    app.on('render-process-gone', this.retireRenderer)
    ipcMain.handle(BACKEND_PORT_REQUEST, (event, token: unknown, purpose: unknown = 'demand') =>
      handleBackendPortRequest(event, token, purpose, {
        documents: this.documents,
        isDesiredRunning: () => this.desiredRunning,
        onActivity: () => this.idleStop.clear(),
        onDocumentRetired: (id) => {
          this.child?.postMessage({ type: 'retire', document: id })
          this.scheduleIdleStopIfUnused()
        },
        acquireReady: (admittedPurpose) => ({
          ready: admittedPurpose === 'recovery' ? this.ready : this.ensureReady(true),
          child: this.child
        }),
        getCurrentChild: () => this.child,
        getIncarnation: () => this.incarnation
      })
    )
    // Start the usage utility process on first demand (BACKEND_PORT_REQUEST or callControl)
    // rather than eagerly at launch, saving ~28 MiB physical footprint when Usage is unused.
  }

  automationClient(provider: 'claudeUsage' | 'codexUsage'): AutomationUsageClient {
    return {
      getAutomationRunUsage: async (input) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The private usage service returns its typed automation result for this provider method.
        (await this.callControl(`${provider}:getAutomationRunUsage`, input)) as Awaited<
          ReturnType<AutomationUsageClient['getAutomationRunUsage']>
        >
    }
  }

  async callControl(method: string, params: unknown): Promise<unknown> {
    this.idleStop.clear()
    this.activeControlCalls += 1
    try {
      const ready = this.ensureReady(true)
      const control = this.control
      await ready
      if (!this.desiredRunning || !control || this.control !== control) {
        throw new Error('Usage disconnected. Try again after it reconnects.')
      }
      return await control.call(method, params)
    } finally {
      this.activeControlCalls -= 1
      this.scheduleIdleStopIfUnused()
    }
  }

  private clearChildState(): void {
    this.child = null
    this.control = null
    this.incarnation = undefined
    this.ready = null
    this.disposeFailedStartup = undefined
  }

  private isUnused(): boolean {
    return Boolean(
      this.child &&
      this.desiredRunning &&
      this.documents.size === 0 &&
      this.activeControlCalls === 0
    )
  }

  private scheduleIdleStopIfUnused(): void {
    if (!this.isUnused()) {
      return
    }
    this.idleStop.schedule(() => {
      if (!this.isUnused() || !this.child) {
        return
      }
      const { child, control } = this
      this.idleRetired.add(child)
      this.clearChildState()
      terminateBackendChild(child, control)
    })
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.desiredRunning = false
      this.idleStop.clear()
      app.off('render-process-gone', this.retireRenderer)
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
      const child = this.child
      for (const document of this.documents.values()) {
        document.retire()
      }
      ipcMain.removeHandler(BACKEND_PORT_REQUEST)
      await stopBackendUtilityChild({
        child,
        control: this.control,
        exited: this.exited,
        isCurrentChild: (candidate) => this.child === candidate,
        deadlineMs: ORCAD_SHUTDOWN_DEADLINE_MS + 1_000
      })
    })()
    return this.stopping
  }

  private notify(connected: boolean, unavailable = false): void {
    for (const document of this.documents.values()) {
      if (!document.contents.isDestroyed() && document.contents.mainFrame === document.frame) {
        document.frame.postMessage(BACKEND_CONNECTION_CHANGED, { connected, unavailable })
      }
    }
  }

  private async ensureReady(explicit: boolean): Promise<void> {
    if (!this.desiredRunning) {
      throw new Error('Orca is shutting down.')
    }
    if (explicit) {
      this.disposeFailedStartup?.()
    }
    if (this.ready) {
      return this.ready
    }
    if (explicit) {
      this.failures.forget('backend')
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    if (this.failures.recent('backend').length >= 3) {
      throw new Error('Usage could not start. Try refreshing the usage view.')
    }
    const { port1, port2 } = new MessageChannelMain()
    const entry = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'backend-entry.js'
    )
    const child = utilityProcess.fork(entry, [], {
      serviceName: BACKEND_UTILITY_PROCESS_NAME,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.child = child
    this.control = new BackendPortRpc(
      backendMessagePort(port1),
      'desktop',
      createBackendDesktopCapabilities(this.store)
    )
    let childPid = child.pid
    child.once('spawn', () => {
      childPid = child.pid
      if (this.child !== child || !this.desiredRunning) {
        child.kill()
      }
    })
    let incarnation: string | undefined
    let settleExit!: () => void
    this.exited = new Promise<void>((resolve) => {
      settleExit = resolve
    })
    let failed!: (error: Error) => void
    let settled = false
    let disposed = false
    const ready = new Promise<void>((resolve, reject) => {
      failed = (error) => {
        if (settled) {
          return
        }
        settled = true
        if (this.child === child && this.ready === ready) {
          this.disposeFailedStartup = () => {
            disposed = true
            const control = this.control
            this.clearChildState()
            clearTimeout(startupDeadline)
            terminateBackendChild(child, control)
          }
        }
        reject(error)
      }
      child.on(
        'message',
        (message: {
          type?: string
          protocol?: number
          capabilities?: string[]
          incarnation?: string
        }) => {
          if (this.child !== child || settled || !this.desiredRunning) {
            return
          }
          if (
            message.type === 'ready' &&
            message.protocol === 1 &&
            message.capabilities?.includes('usage') &&
            typeof message.incarnation === 'string'
          ) {
            incarnation = message.incarnation
            this.incarnation = incarnation
            settled = true
            clearTimeout(startupDeadline)
            resolve()
            this.notify(true)
          }
          if (message.type === 'failed') {
            failed(new Error('Usage could not start. Try refreshing the usage view.'))
            child.kill()
          }
        }
      )
    })
    this.ready = ready
    const startupDeadline = setTimeout(() => {
      failed(new Error('Usage is still unavailable. Try refreshing the usage view.'))
      if (this.child === child) {
        child.kill()
      }
    }, ORCAD_SHUTDOWN_DEADLINE_MS * 2)
    child.stderr?.on('data', (chunk: Buffer) =>
      console.warn(`[backend] ${chunk.toString().slice(0, 16_384)}`)
    )
    child.on('error', () => {
      failed(new Error('Usage could not start. Try refreshing the usage view.'))
    })
    child.once('exit', (code) => {
      const idleRetired = this.idleRetired.has(child)
      recordDurableCrashBreadcrumb('backend_process_exited', {
        pid: childPid ?? null,
        incarnation: incarnation ?? null,
        exitCode: code,
        expected: disposed || idleRetired || !this.desiredRunning
      })
      clearTimeout(startupDeadline)
      failed(new Error('Usage disconnected. Try again after it reconnects.'))
      if (this.child === child) {
        this.control?.close()
        this.clearChildState()
        if (this.desiredRunning) {
          this.failures.record('backend')
        }
        this.notify(false, this.desiredRunning && this.failures.recent('backend').length >= 3)
        if (this.desiredRunning && this.documents.size > 0) {
          if (this.failures.recent('backend').length < 3) {
            const restartTimer = setTimeout(
              () => {
                if (this.restartTimer !== restartTimer) {
                  return
                }
                this.restartTimer = undefined
                void this.ensureReady(false).catch(() => {})
              },
              250 * 2 ** this.failures.recent('backend').length
            )
            this.restartTimer = restartTimer
          }
        }
      }
      settleExit()
    })
    sendBackendBootstrap(child, port2, () => this.child === child)
    return ready
  }
}
