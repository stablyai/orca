import { app, BrowserWindow, webFrameMain } from 'electron'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import { getHostSessionState } from './browser-extension-contexts'
import {
  BrowserExtensionApiError,
  type BrowserExtensionCaller
} from './browser-extension-namespace-registry'
import {
  defaultNativeHostLookupDeps,
  nativeHostOriginArgument,
  resolveNativeMessagingHost
} from './browser-extension-native-host-lookup'
import { startNativeHost, type NativeHostConnection } from './browser-extension-native-host-process'

/**
 * Native host connections, each owned by the extension context that opened it: one page frame or
 * the extension's service worker in one session. Only that context can use the port, and the host
 * is killed when the context ends, the extension unloads, or the profile session goes away.
 */

export type NativePortEvent =
  | { type: 'message'; json: string }
  /** `teardown`: Orca closed it because its context ended, so nobody is listening. */
  | { type: 'disconnect'; error: string; teardown?: boolean }

type PortOwner =
  | { kind: 'worker'; versionId: number | null }
  | { kind: 'frame'; webContentsId: number; processId: number; routingId: number }

type NativePort = {
  key: string
  session: Electron.Session
  extensionId: string
  owner: PortOwner
  connection: NativeHostConnection | null
  closed: boolean
  /** Keeps the owning worker alive while the port is open, as Chrome does. */
  task: Electron.StartTask | null
  onEvent: (event: NativePortEvent) => void
}

export type NativePortHandle = { post: (json: string) => void; close: () => void }

const FRAME_SWEEP_MS = 5_000

const ports = new Map<string, NativePort>()
const sessionIds = new WeakMap<Electron.Session, number>()
let nextSessionId = 1
const observedSessions = new WeakSet<Electron.Session>()
const observedContents = new WeakSet<Electron.WebContents>()
let frameSweep: NodeJS.Timeout | null = null
let framePortCount = 0

function sessionId(sess: Electron.Session): number {
  let id = sessionIds.get(sess)
  if (id === undefined) {
    id = nextSessionId++
    sessionIds.set(sess, id)
  }
  return id
}

function ownerOf(caller: BrowserExtensionCaller): PortOwner | null {
  if (caller.fromWorker) {
    const running = getHostSessionState(caller.session)?.workers.get(caller.extension.id)?.running
    return {
      kind: 'worker',
      versionId: running && !running.isDestroyed() ? running.versionId : null
    }
  }
  if (caller.webContents && caller.frame && !caller.frame.isDestroyed()) {
    return {
      kind: 'frame',
      webContentsId: caller.webContents.id,
      processId: caller.frame.processId,
      routingId: caller.frame.routingId
    }
  }
  return null
}

function portKey(caller: BrowserExtensionCaller, owner: PortOwner, portId: string): string {
  const context =
    owner.kind === 'worker'
      ? 'worker'
      : `frame:${owner.webContentsId}:${owner.processId}:${owner.routingId}`
  return `${sessionId(caller.session)}|${caller.extension.id}|${context}|${portId}`
}

function finish(port: NativePort): void {
  if (port.closed) {
    return
  }
  port.closed = true
  ports.delete(port.key)
  if (port.owner.kind === 'frame') {
    framePortCount -= 1
  }
  port.task?.end()
  port.connection?.close()
  if (frameSweep && framePortCount === 0) {
    clearInterval(frameSweep)
    frameSweep = null
  }
}

/** Ends matching ports without telling their (gone) contexts; their hosts are killed. */
export function closeNativePortsWhere(matches: (port: NativePort) => boolean): void {
  for (const port of ports.values()) {
    if (matches(port)) {
      finish(port)
      port.onEvent({ type: 'disconnect', error: 'The port owner went away', teardown: true })
    }
  }
}

function frameStillOwns(port: NativePort): boolean {
  if (port.owner.kind !== 'frame') {
    return true
  }
  const frame = webFrameMain.fromId(port.owner.processId, port.owner.routingId)
  return Boolean(
    frame &&
    !frame.isDestroyed() &&
    frame.url.startsWith(getChromeExtensionOrigin(port.extensionId))
  )
}

function observeSession(sess: Electron.Session): void {
  if (observedSessions.has(sess)) {
    return
  }
  observedSessions.add(sess)
  // Disable, removal, reload and profile deletion all unload the extension from the session.
  sess.extensions.on('extension-unloaded', (_event, extension) =>
    closeNativePortsWhere((port) => port.session === sess && port.extensionId === extension.id)
  )
  sess.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus === 'stopped') {
      closeNativePortsWhere(
        (port) =>
          port.session === sess &&
          port.owner.kind === 'worker' &&
          port.owner.versionId === versionId
      )
    }
  })
}

function observeFrameOwner(contents: Electron.WebContents): void {
  if (!frameSweep) {
    // Why a sweep: Electron has no event for an extension iframe being removed from its page.
    frameSweep = setInterval(
      () => closeNativePortsWhere((port) => !frameStillOwns(port)),
      FRAME_SWEEP_MS
    )
    frameSweep.unref()
  }
  if (observedContents.has(contents)) {
    return
  }
  observedContents.add(contents)
  const id = contents.id
  const inContents = (port: NativePort): boolean =>
    port.owner.kind === 'frame' && port.owner.webContentsId === id
  contents.once('destroyed', () => closeNativePortsWhere(inContents))
  contents.on('render-process-gone', () => closeNativePortsWhere(inContents))
  contents.on(
    'did-frame-navigate',
    (_event, _url, _code, _status, isMainFrame, frameProcessId, frameRoutingId) =>
      closeNativePortsWhere(
        (port) =>
          inContents(port) &&
          port.owner.kind === 'frame' &&
          (isMainFrame ||
            (port.owner.processId === frameProcessId && port.owner.routingId === frameRoutingId))
      )
  )
}

/** Chrome passes the extension's window on Windows so a host can parent its dialogs; 0 for workers. */
function parentWindowArgument(caller: BrowserExtensionCaller): string {
  const contents = caller.webContents
  const window = contents
    ? (BrowserWindow.fromWebContents(contents) ??
      (contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null))
    : null
  const handle = window && !window.isDestroyed() ? window.getNativeWindowHandle() : null
  const value = !handle
    ? 0
    : handle.length >= 8
      ? handle.readBigUInt64LE(0)
      : handle.readUInt32LE(0)
  return `--parent-window=${value}`
}

function startTask(owner: PortOwner, caller: BrowserExtensionCaller): Electron.StartTask | null {
  if (owner.kind !== 'worker') {
    return null
  }
  const running = getHostSessionState(caller.session)?.workers.get(caller.extension.id)?.running
  try {
    return running && !running.isDestroyed() ? running.startTask() : null
  } catch {
    return null
  }
}

/** Starts the host; resolves once it runs, rejects with Chrome's error message otherwise. */
export async function openNativePort(
  caller: BrowserExtensionCaller,
  portId: string,
  application: string,
  onEvent: (event: NativePortEvent) => void
): Promise<NativePortHandle> {
  const owner = ownerOf(caller)
  if (!owner) {
    throw new BrowserExtensionApiError('Not an extension context')
  }
  const key = portKey(caller, owner, portId)
  if (ports.has(key)) {
    throw new BrowserExtensionApiError('This port is already open')
  }
  const port: NativePort = {
    key,
    session: caller.session,
    extensionId: caller.extension.id,
    owner,
    connection: null,
    closed: false,
    task: startTask(owner, caller),
    onEvent
  }
  ports.set(key, port)
  if (owner.kind === 'frame') {
    framePortCount += 1
  }
  observeSession(caller.session)
  if (caller.webContents && owner.kind === 'frame') {
    observeFrameOwner(caller.webContents)
  }
  const handle: NativePortHandle = {
    post: (json) => port.connection?.send(json),
    close: () => finish(port)
  }
  try {
    const host = await resolveNativeMessagingHost(
      application,
      caller.extension.id,
      defaultNativeHostLookupDeps(app.getPath('userData'))
    )
    if (!host.ok) {
      throw new BrowserExtensionApiError(host.error)
    }
    // Why: the owner can go away (unload, worker stop) during the lookup; never start its host then.
    if (port.closed) {
      throw new BrowserExtensionApiError('The port owner went away')
    }
    const args = [nativeHostOriginArgument(caller.extension.id)]
    if (process.platform === 'win32') {
      args.push(parentWindowArgument(caller))
    }
    const connection = await startNativeHost(
      { name: application, program: host.program, args },
      {
        onMessage: (json) => {
          if (!port.closed) {
            onEvent({ type: 'message', json })
          }
        },
        onClose: (error) => {
          if (!port.closed) {
            finish(port)
            onEvent({ type: 'disconnect', error })
          }
        }
      }
    )
    port.connection = connection
    // Torn down (or ended by the host) while starting: close() is a no-op for an ended channel.
    if (port.closed) {
      connection.close()
    }
    return handle
  } catch (error) {
    finish(port)
    throw error instanceof BrowserExtensionApiError
      ? error
      : new BrowserExtensionApiError(error instanceof Error ? error.message : String(error))
  }
}

/** The caller's own open port, or null; another context's port with the same id is not visible. */
export function findNativePort(
  caller: BrowserExtensionCaller,
  portId: string
): NativePortHandle | null {
  const owner = ownerOf(caller)
  const port = owner ? ports.get(portKey(caller, owner, portId)) : undefined
  return port ? { post: (json) => port.connection?.send(json), close: () => finish(port) } : null
}
