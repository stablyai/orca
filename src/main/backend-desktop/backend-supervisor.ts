import { app, ipcMain, MessageChannelMain, utilityProcess, type WebContents } from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { BackendPortRpc } from '../../shared/backend-port-rpc'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_DELIVERY,
  BACKEND_PORT_REQUEST,
  BACKEND_UTILITY_PROCESS_NAME,
  type AutomationUsageClient
} from '../../shared/backend-service-contract'
import { backendMessagePort } from '../backend/backend-message-port'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { ManagedOrcadEventWindow } from '../managed-server/lifecycle/orcad-managed-event-window'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from '../orcad/orcad-stop-deadlines'
import {
  createBackendDesktopCapabilities,
  trustsBackendRenderer,
  trackBackendDocument,
  type BackendDocument
} from './backend-desktop-capabilities'
import type { UsageWorktreeSource } from '../usage/worktree-attribution/usage-worktree-metadata'

export { captureBackendBootstrap } from './backend-bootstrap'
import { capturedBootstrap } from './backend-bootstrap'

export class BackendSupervisor {
  private child: ReturnType<typeof utilityProcess.fork> | null = null
  private control: BackendPortRpc | null = null
  private ready: Promise<void> | null = null
  private disposeFailedStartup?: () => void
  private desiredRunning = true
  private exited: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readonly failures = new ManagedOrcadEventWindow(10 * 60_000, Date.now)
  private readonly documents = new Map<number, BackendDocument>()
  private stopping?: Promise<void>

  private readonly retireRenderer = (_event: unknown, contents: WebContents): void =>
    this.documents.get(contents.id)?.retire()

  constructor(private readonly store: UsageWorktreeSource) {
    if (!capturedBootstrap) {
      throw new Error('Backend paths were not captured during preflight.')
    }
    app.on('render-process-gone', this.retireRenderer)
    ipcMain.handle(
      BACKEND_PORT_REQUEST,
      async (event, token: unknown, purpose: unknown = 'demand') => {
        if (
          typeof token !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(token) ||
          (purpose !== 'demand' && purpose !== 'recovery')
        ) {
          throw new Error('Invalid backend connection request.')
        }
        const { sender, senderFrame } = event
        if (!senderFrame || senderFrame !== sender.mainFrame || !trustsBackendRenderer(sender)) {
          throw new Error('This document cannot connect to Orca.')
        }
        const document = trackBackendDocument(
          this.documents,
          sender,
          senderFrame,
          token,
          (retiredToken) => this.child?.postMessage({ type: 'retire', token: retiredToken })
        )
        if (!this.desiredRunning) {
          throw new Error('Orca is shutting down.')
        }
        const ready = purpose === 'recovery' ? this.ready : this.ensureReady(true)
        const child = this.child
        if (!ready) {
          throw new Error('Usage is unavailable. Try refreshing the usage view.')
        }
        await ready
        if (
          this.documents.get(sender.id) !== document ||
          !this.desiredRunning ||
          !child ||
          this.child !== child ||
          sender.isDestroyed() ||
          sender.mainFrame !== senderFrame
        ) {
          throw new Error('The document was replaced before Orca connected.')
        }
        const { port1, port2 } = new MessageChannelMain()
        child.postMessage({ type: 'client', token: document.token }, [port1])
        senderFrame.postMessage(BACKEND_PORT_DELIVERY, { token: document.token }, [port2])
        return document.token
      }
    )
    void this.ensureReady(false).catch(() => {})
  }

  automationClient(provider: 'claudeUsage' | 'codexUsage'): AutomationUsageClient {
    return {
      getAutomationRunUsage: async (input) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The private usage service returns its typed automation result for this provider method.
        (await this.callPrivileged(`${provider}:getAutomationRunUsage`, input, true)) as Awaited<
          ReturnType<AutomationUsageClient['getAutomationRunUsage']>
        >
    }
  }

  /** A main-process call into the usage service; `explicit` also retries a failed startup. */
  async callPrivileged(method: string, params: unknown, explicit: boolean): Promise<unknown> {
    const ready = this.ensureReady(explicit)
    const control = this.control
    await ready
    if (!this.desiredRunning || !control || this.control !== control) {
      throw new Error('Usage disconnected. Try again after it reconnects.')
    }
    return control.call(method, params)
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.desiredRunning = false
      app.off('render-process-gone', this.retireRenderer)
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
      const child = this.child
      for (const document of this.documents.values()) {
        document.retire()
      }
      ipcMain.removeHandler(BACKEND_PORT_REQUEST)
      if (!child) {
        return
      }
      const exited = this.exited
      const deadline = setTimeout(() => {
        if (this.child === child) {
          child.kill()
        }
      }, ORCAD_SHUTDOWN_DEADLINE_MS + 1_000)
      this.control?.close()
      await exited
      clearTimeout(deadline)
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
            this.child = null
            this.control = null
            this.ready = null
            this.disposeFailedStartup = undefined
            clearTimeout(startupDeadline)
            control?.close()
            try {
              child.kill()
            } catch {}
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
            message.capabilities?.includes('usage')
          ) {
            incarnation = message.incarnation
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
      recordDurableCrashBreadcrumb('backend_process_exited', {
        pid: childPid ?? null,
        incarnation: incarnation ?? null,
        exitCode: code,
        expected: disposed || !this.desiredRunning
      })
      clearTimeout(startupDeadline)
      failed(new Error('Usage disconnected. Try again after it reconnects.'))
      if (this.child === child) {
        this.control?.close()
        this.control = null
        this.child = null
        this.ready = null
        this.disposeFailedStartup = undefined
        if (this.desiredRunning) {
          this.failures.record('backend')
        }
        this.notify(false, this.desiredRunning && this.failures.recent('backend').length >= 3)
        if (this.desiredRunning) {
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
    child.postMessage({ type: 'bootstrap', config: capturedBootstrap }, [port2])
    return ready
  }
}
