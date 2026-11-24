import { BROWSER_EXPECT_URL_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  BROWSER_EXPECT_URL_UNSUPPORTED_CODE,
  BrowserExpectedUrlMismatch
} from '../../../../shared/browser/client-hosting/browser-expected-url'
import { browserExpectedUrlMismatchError } from '../../../browser/cdp/input/browser-expected-page-url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { BrowserError } from '../../../browser/browser-error'
import type { RuntimeBrowserCommandHost } from '../../../runtime/browser/commands/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../../../runtime/browser/commands/browser-commands'
import type { RuntimeMetadata } from '../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { readRuntimeMetadata } from '../../../runtime/rpc/server/runtime-metadata'
import { spawnProcess } from '@orca/process-host'
import { isProcessAlive } from '../../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import { BROWSER_SIDECAR_OWNER_ENV } from '../../../../shared/browser/runtime/browser-sidecar-lifetime'
import { electronIsolatedProfileSwitches } from '../../../../shared/app-lifecycle/launch/electron-isolated-profile-switches'
import { headlessServeOzonePlatformSwitches } from '../../../../shared/app-lifecycle/launch/headless-serve-ozone-platform'
import { sendOrcadSidecarRequest } from '../orcad-sidecar-runtime-client'
import { browserWaitRequestTimeoutMs } from '../../../../shared/browser/automation/browser-wait-timeout'
import { electronServeEnvironment } from './electron-serve-browser-environment'
import { reserveLoopbackPort } from './loopback-port-reservation'
import {
  launchOnElectronSidecarProfile,
  stopAnsweringElectronSidecar,
  stopElectronSidecar,
  type ElectronSidecarProfile
} from './electron-sidecar-profile'
import {
  ElectronSidecarTabRegistry,
  ElectronSidecarTabSchema,
  type ElectronSidecarPage
} from './electron-sidecar-tab-registry'
import {
  electronSidecarRuntimeMethodName,
  TARGETLESS_BROWSER_METHODS
} from './electron-sidecar-method-routing'

const START_TIMEOUT_MS = 120_000
type SidecarRequest = (method: string, params: unknown) => Promise<unknown>
const BrowserPageResult = z.object({ browserPageId: z.string() }).passthrough()
const BrowserCloseResult = z.object({ closed: z.boolean() }).passthrough()
const BrowserTabListResult = z.object({ tabs: z.array(ElectronSidecarTabSchema) }).passthrough()
const RuntimeStatusResult = z.object({ capabilities: z.array(z.string()).optional() }).passthrough()

export class ElectronServeBrowserProcess {
  private child: ReturnType<typeof spawnProcess> | null = null
  private metadata: RuntimeMetadata | null = null
  private readonly tabs = new ElectronSidecarTabRegistry()
  private sidecarCapabilities: readonly string[] = []
  private sidecarProfile: ElectronSidecarProfile | null = null
  private readonly request = sendOrcadSidecarRequest

  constructor(
    private readonly executablePath: string,
    private readonly orcadUserDataPath: string
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    this.sidecarCapabilities = []
    signal?.throwIfAborted()
    await launchOnElectronSidecarProfile(
      this.orcadUserDataPath,
      (profile) => this.launch(profile, signal),
      // Retry only an app that exited on its own, after this attempt is cleaned up.
      async () => (this.pid() === null && !signal?.aborted ? this.stop().then(() => true) : false)
    )
  }

  private async launch(profile: ElectronSidecarProfile, signal?: AbortSignal): Promise<void> {
    this.sidecarProfile = profile
    const userDataPath = profile.path
    const port = await reserveLoopbackPort()
    signal?.throwIfAborted()
    const child = spawnProcess({
      program: this.executablePath,
      args: [
        '--serve',
        '--serve-port',
        String(port),
        '--serve-json',
        '--serve-no-pairing',
        ...electronIsolatedProfileSwitches(process.env),
        ...headlessServeOzonePlatformSwitches(process.platform),
        `--user-data-dir=${userDataPath}`
      ],
      env: { ...electronServeEnvironment(userDataPath), [BROWSER_SIDECAR_OWNER_ENV]: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json'
    })
    this.child = child
    let spawnError: unknown = null
    // Bundle swaps can race restart; report ENOENT as start failure without crashing orcad.
    child.on('error', (error) => {
      spawnError = error
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', () => undefined)
      stream?.resume()
    }
    const deadline = Date.now() + START_TIMEOUT_MS
    let lastError: unknown = null
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const metadata = readRuntimeMetadata(userDataPath)
      if (metadata) {
        try {
          const status = RuntimeStatusResult.parse(
            await this.request(metadata, 'status.get', undefined, 5_000)
          )
          signal?.throwIfAborted()
          if (status.capabilities?.includes('browser.headless.v1')) {
            this.sidecarCapabilities = status.capabilities
            this.metadata = metadata
            return
          }
          lastError = new Error('Installed Electron app omitted browser.headless.v1.')
        } catch (error) {
          lastError = error
        }
      }
      if (spawnError) {
        lastError = spawnError
        break
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break
      }
      await delay(100, undefined, { signal })
    }
    throw new Error(
      `Installed Electron browser provider did not become ready: ${
        lastError instanceof Error ? lastError.message : 'no runtime metadata'
      }`
    )
  }

  createCommands(host: RuntimeBrowserCommandHost): RuntimeBrowserCommands {
    return new Proxy({} as RuntimeBrowserCommands, {
      // Startup checks membership before resolving commands dynamically.
      has: (_target, property) => typeof property === 'string' && property !== 'then',
      get: (_target, property) => {
        if (property === 'then' || typeof property !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => this.invoke(host, property, args)
      }
    })
  }
  /** Requests to the running sidecar, when it advertises `capability` (on a kept profile). */
  sidecarWith(capability: string, { persistent = false } = {}): SidecarRequest | null {
    const kept = !persistent || this.sidecarProfile?.persistent === true
    const { metadata } = this
    return metadata && kept && this.isAvailable() && this.sidecarCapabilities.includes(capability)
      ? (method, params) => this.request(metadata, method, params)
      : null
  }

  isAvailable(): boolean {
    return this.metadata !== null && isProcessAlive(this.metadata.pid)
  }

  /** Read child exit state so recycled PIDs cannot identify an unrelated process. */
  pid(): number | null {
    const child = this.child
    return child?.pid && child.exitCode === null && child.signalCode === null ? child.pid : null
  }

  async stop(): Promise<void> {
    const childPid = this.pid()
    const { metadata, sidecarProfile: profile } = this
    this.child = null
    this.metadata = null
    this.sidecarCapabilities = []
    this.sidecarProfile = null
    this.tabs.clear()
    if (childPid !== null) {
      await stopElectronSidecar(metadata?.pid ?? childPid)
    } else if (metadata) {
      // The child is gone, so its pids may be recycled; signal only a sidecar that still answers.
      await stopAnsweringElectronSidecar(metadata)
    }
    if (profile && !profile.persistent) {
      // Windows helpers may briefly hold this temp profile; cleanup failure must not strand the instance lock.
      await removeTree(profile.path).catch((error: unknown) =>
        console.warn('[orcad] Electron browser sidecar data was not removed:', error)
      )
    }
  }

  private async invoke(
    host: RuntimeBrowserCommandHost,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (method === 'browserScreencast') {
      throw new BrowserError(
        'browser_screencast_unavailable',
        'The orcad Electron provider does not proxy screencast.'
      )
    }
    const metadata = this.metadata
    if (!metadata) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'The Electron browser provider is not running.'
      )
    }
    const original = (args[0] ?? {}) as Record<string, unknown>
    // The sidecar is the installed app, which can be older and would drop the field.
    if (
      original.expectUrl !== undefined &&
      !this.sidecarCapabilities.includes(BROWSER_EXPECT_URL_RUNTIME_CAPABILITY)
    ) {
      throw new BrowserError(
        BROWSER_EXPECT_URL_UNSUPPORTED_CODE,
        'The installed Orca app that runs this server’s browser cannot check --expect-url. Update it or drop the flag.'
      )
    }
    const worktreeId =
      typeof original.worktree === 'string'
        ? (await host.resolveBrowserWorkspace(original.worktree)).id
        : undefined
    const params: Record<string, unknown> = { ...original, worktree: undefined }
    const requestedPageId = typeof original.page === 'string' ? original.page : undefined
    const requestedIndex = typeof original.index === 'number' ? original.index : undefined
    let targetPage: ElectronSidecarPage | undefined
    let rpcMethod = electronSidecarRuntimeMethodName(method)
    if (method === 'browserTabCreate' && requestedPageId) {
      const existing = this.tabs.find(requestedPageId)
      if (existing) {
        this.tabs.require(requestedPageId, worktreeId)
        return { browserPageId: requestedPageId }
      }
      // Sidecars mint their own IDs; adopt the caller’s provisional ID after creation.
      delete params.page
    }

    if (method === 'browserTabCurrent' && worktreeId) {
      targetPage = this.tabs.active(worktreeId)
      rpcMethod = 'browser.tabShow'
      params.page = targetPage.sidecarPageId
    } else if (method === 'browserTabSwitch' || method === 'browserTabClose') {
      targetPage = requestedPageId
        ? this.tabs.require(requestedPageId, worktreeId)
        : requestedIndex !== undefined
          ? this.tabs.pageAt(worktreeId, requestedIndex)
          : worktreeId
            ? this.tabs.active(worktreeId)
            : undefined
      if (targetPage) {
        params.page = targetPage.sidecarPageId
        delete params.index
      }
    } else if (requestedPageId && method !== 'browserTabCreate') {
      targetPage = this.tabs.require(requestedPageId, worktreeId)
      params.page = targetPage.sidecarPageId
    } else if (worktreeId && !TARGETLESS_BROWSER_METHODS[method]) {
      targetPage = this.tabs.active(worktreeId)
      params.page = targetPage.sidecarPageId
    }

    let result: unknown
    try {
      result = await this.request(
        metadata,
        rpcMethod,
        params,
        method === 'browserWait' ? browserWaitRequestTimeoutMs(params.timeout) : undefined
      )
    } catch (error) {
      if (
        targetPage &&
        error instanceof BrowserError &&
        (error.code === 'browser_tab_not_found' || error.code === 'browser_tab_closed')
      ) {
        this.tabs.delete(targetPage)
      }
      // The sidecar named its own page id, which the caller's --page can't use.
      const mismatch =
        error instanceof BrowserError
          ? BrowserExpectedUrlMismatch.safeParse(this.tabs.rewriteResult(error.data))
          : null
      throw mismatch?.success ? browserExpectedUrlMismatchError(mismatch.data) : error
    }
    if (method === 'browserTabCreate') {
      const created = BrowserPageResult.parse(result)
      const page = this.tabs.register(created.browserPageId, requestedPageId, worktreeId)
      return { ...created, browserPageId: page.publicPageId }
    }
    if (method === 'browserTabList') {
      const listed = BrowserTabListResult.parse(result)
      return { ...listed, tabs: this.tabs.reconcileTabs(listed.tabs, worktreeId) }
    }
    if (method === 'browserTabSwitch') {
      const switched = BrowserPageResult.parse(result)
      const page = this.tabs.pageForSidecar(switched.browserPageId)
      if (page) {
        this.tabs.setActive(page)
      }
      return {
        ...switched,
        ...(requestedIndex !== undefined ? { switched: requestedIndex } : {}),
        browserPageId: this.tabs.publicPageId(switched.browserPageId)
      }
    }
    if (method === 'browserTabClose' && targetPage) {
      const closed = BrowserCloseResult.parse(result)
      if (closed.closed) {
        this.tabs.delete(targetPage)
      }
      return closed
    }
    if (method === 'browserTabProfileClone') {
      const cloned = BrowserPageResult.parse(result)
      this.tabs.register(cloned.browserPageId, undefined, targetPage?.worktreeId)
    }
    return this.tabs.rewriteResult(result)
  }
}
