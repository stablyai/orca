import { mkdtemp } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { BrowserError } from '../browser/browser-error'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { spawnProcess } from '@orca/process-host'
import { isProcessAlive } from '../../shared/serve-bundle-coordination'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { BROWSER_SIDECAR_OWNER_ENV } from '../../shared/browser-sidecar-lifetime'
import { electronIsolatedProfileSwitches } from '../../shared/electron-isolated-profile-switches'
import { headlessServeOzonePlatformSwitches } from '../../shared/headless-serve-ozone-platform'
import { sendOrcadSidecarRequest } from './orcad-sidecar-runtime-client'
import { electronServeEnvironment } from './electron-serve-browser-environment'
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
const STOP_TIMEOUT_MS = 5_000
const BrowserPageResult = z.object({ browserPageId: z.string() }).passthrough()
const BrowserCloseResult = z.object({ closed: z.boolean() }).passthrough()
const BrowserTabListResult = z.object({ tabs: z.array(ElectronSidecarTabSchema) }).passthrough()
const RuntimeStatusResult = z.object({ capabilities: z.array(z.string()).optional() }).passthrough()

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  return address.port
}
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The sidecar already exited.
  }
}

export class ElectronServeBrowserProcess {
  private child: ReturnType<typeof spawnProcess> | null = null
  private metadata: RuntimeMetadata | null = null
  private readonly tabs = new ElectronSidecarTabRegistry()
  private sidecarDataPath: string | null = null

  constructor(private readonly executablePath: string) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
    const userDataPath = await mkdtemp(join(temporaryRoot, 'orcad-browser-'))
    this.sidecarDataPath = userDataPath
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
    // Why: a restart can race the bundle swap after an install; ENOENT must fail start, not orcad.
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
            await sendOrcadSidecarRequest(metadata, 'status.get', undefined, 5_000)
          )
          signal?.throwIfAborted()
          if (status.capabilities?.includes('browser.headless.v1')) {
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
      // Why: startup checks membership before invoking dynamically resolved commands.
      has: (_target, property) => typeof property === 'string' && property !== 'then',
      get: (_target, property) => {
        if (property === 'then') {
          return undefined
        }
        if (typeof property !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => this.invoke(host, property, args)
      }
    })
  }
  isAvailable(): boolean {
    return this.metadata !== null && isProcessAlive(this.metadata.pid)
  }

  /** From the child's own exit state, so a recycled pid is never reported as the helper. */
  pid(): number | null {
    const child = this.child
    return child?.pid && child.exitCode === null && child.signalCode === null ? child.pid : null
  }

  async stop(): Promise<void> {
    const child = this.child
    const sidecarPid = this.metadata?.pid ?? child?.pid ?? null
    const sidecarDataPath = this.sidecarDataPath
    this.child = null
    this.metadata = null
    this.sidecarDataPath = null
    this.tabs.clear()
    if (sidecarPid) {
      signalProcess(sidecarPid, 'SIGTERM')
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (isProcessAlive(sidecarPid) && Date.now() < deadline) {
        await delay(50)
      }
      if (isProcessAlive(sidecarPid)) {
        signalProcess(sidecarPid, 'SIGKILL')
      }
    }
    if (sidecarDataPath) {
      // Why best-effort: on Windows the killed sidecar's helpers hold this throwaway profile for a
      // moment, and a leftover temp dir must not fail orcad's stop and strand its instance lock.
      await removeTree(sidecarDataPath).catch((error: unknown) =>
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
      // The sidecar mints its own tab id; adopt the caller's provisional id after creating it.
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
      result = await sendOrcadSidecarRequest(metadata, rpcMethod, params)
    } catch (error) {
      if (
        targetPage &&
        error instanceof BrowserError &&
        (error.code === 'browser_tab_not_found' || error.code === 'browser_tab_closed')
      ) {
        this.tabs.delete(targetPage)
      }
      throw error
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
