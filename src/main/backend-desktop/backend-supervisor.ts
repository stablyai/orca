import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { join } from 'node:path'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { pathToFileURL } from 'node:url'
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
import { isRendererDocumentNavigation } from '../window/renderer-document-navigation'
import { createBackendDesktopCapabilities } from './backend-desktop-capabilities'
import type { Store } from '../persistence/loading-store/store'

export { captureBackendBootstrap } from './backend-bootstrap'
import { capturedBootstrap } from './backend-bootstrap'

type Document = { contents: WebContents; frame: WebFrameMain; token: string; retire(): void }

export class BackendSupervisor {
  private child: ReturnType<typeof utilityProcess.fork> | null = null
  private control: BackendPortRpc | null = null
  private ready: Promise<void> | null = null
  private desiredRunning = true
  private exited: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readonly failures = new ManagedOrcadEventWindow(10 * 60_000, Date.now)
  private readonly documents = new Map<number, Document>()
  private stopping?: Promise<void>

  private readonly retireRenderer = (_event: unknown, contents: WebContents): void =>
    this.documents.get(contents.id)?.retire()

  constructor(private readonly store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
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
        if (!senderFrame || senderFrame !== sender.mainFrame || !this.trusts(sender)) {
          throw new Error('This document cannot connect to Orca.')
        }
        this.documents.get(sender.id)?.retire()
        const document: Document = {
          contents: sender,
          frame: senderFrame,
          token,
          retire: () => {}
        }
        const retire = (): void => {
          if (this.documents.get(sender.id) !== document) {
            return
          }
          this.documents.delete(sender.id)
          this.child?.postMessage({ type: 'retire', token: document.token })
          sender.off('did-frame-navigate', navigation)
          sender.off('destroyed', retire)
        }
        const navigation = (
          _event: unknown,
          _url: string,
          _httpCode: number,
          _httpStatus: string,
          mainFrame: boolean
        ): void => {
          if (mainFrame) {
            retire()
          }
        }
        document.retire = retire
        this.documents.set(sender.id, document)
        sender.on('did-frame-navigate', navigation)
        sender.once('destroyed', retire)
        if (!this.desiredRunning) {
          throw new Error('Orca is shutting down.')
        }
        const ready = purpose === 'recovery' ? this.ready : this.ensureReady(true)
        if (!ready) {
          throw new Error('Usage is unavailable. Try refreshing the usage view.')
        }
        await ready
        if (
          this.documents.get(sender.id) !== document ||
          sender.isDestroyed() ||
          sender.mainFrame !== senderFrame
        ) {
          throw new Error('The document was replaced before Orca connected.')
        }
        const { port1, port2 } = new MessageChannelMain()
        this.child!.postMessage({ type: 'client', token: document.token }, [port1])
        senderFrame.postMessage(BACKEND_PORT_DELIVERY, { token: document.token }, [port2])
        return document.token
      }
    )
    void this.ensureReady(false).catch(() => {})
  }

  automationClient(provider: 'claudeUsage' | 'codexUsage'): AutomationUsageClient {
    return {
      getAutomationRunUsage: async (input) => {
        await this.ensureReady(true)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The private usage service returns its typed automation result for this provider method.
        return (await this.control!.call(`${provider}:getAutomationRunUsage`, input)) as Awaited<
          ReturnType<AutomationUsageClient['getAutomationRunUsage']>
        >
      }
    }
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

  private trusts(contents: WebContents): boolean {
    if (
      contents.isDestroyed() ||
      contents.getType() !== 'window' ||
      !BrowserWindow.fromWebContents(contents)
    ) {
      return false
    }
    const layout = currentWorkerEntryLayout(__dirname)
    const roots = process.env.ELECTRON_RENDERER_URL
      ? [process.env.ELECTRON_RENDERER_URL]
      : ['index.html', 'space.html', 'popout.html'].map(
          (name) => pathToFileURL(join(layout.moduleDir, '../renderer', name)).href
        )
    return roots.some((root) => isRendererDocumentNavigation(root, contents.getURL()))
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
    })
    let incarnation: string | undefined
    let settleExit!: () => void
    this.exited = new Promise<void>((resolve) => {
      settleExit = resolve
    })
    let failed!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      failed = reject
      child.on(
        'message',
        (message: {
          type?: string
          protocol?: number
          capabilities?: string[]
          incarnation?: string
        }) => {
          if (this.child !== child) {
            return
          }
          if (
            message.type === 'ready' &&
            message.protocol === 1 &&
            message.capabilities?.includes('usage')
          ) {
            incarnation = message.incarnation
            clearTimeout(startupDeadline)
            resolve()
            this.notify(true)
          }
          if (message.type === 'failed') {
            reject(new Error('Usage could not start. Try refreshing the usage view.'))
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
        expected: !this.desiredRunning
      })
      clearTimeout(startupDeadline)
      failed(new Error('Usage disconnected. Try again after it reconnects.'))
      if (this.child === child) {
        this.control?.close()
        this.control = null
        this.child = null
        this.ready = null
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
