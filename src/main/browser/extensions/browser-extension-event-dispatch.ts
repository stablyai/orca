import { webFrameMain } from 'electron'
import {
  BROWSER_EXTENSION_EVENT_CHANNEL,
  type BrowserExtensionEventPayload
} from '../../../shared/browser-extension-channels'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import type { HostSessionState, WorkerContext } from './browser-extension-contexts'
import {
  browserExtensionFrameRevision,
  forgetBrowserExtensionFrame,
  type FrameContext
} from './browser-extension-frame-lifetime'
import {
  extensionHasNamespacePermission,
  getBrowserExtensionNamespace
} from './browser-extension-namespace-registry'
import { deliverToWorker } from './browser-extension-worker-event-stream'

export type BrowserExtensionEventTarget = {
  /** Only extensions loaded in this session; omit to reach every extension session. */
  session?: Electron.Session
  extensionId?: string
  /** The calling page frame or worker, which delivers this event to itself. */
  exceptCaller?: { frame?: Electron.WebFrameMain; fromWorker?: boolean }
}

/** Per-extension args let an event hide fields an extension may not see; null skips it. */
export type BrowserExtensionEventArgs =
  | unknown[]
  | ((extension: Electron.Extension, session: Electron.Session) => unknown[] | null)

export function eventKey(namespace: string, event: string): string {
  return `${namespace}.${event}`
}

function listensFor(
  context: Pick<FrameContext, 'events' | 'filters'>,
  key: string,
  matchesFilter: ((filter: unknown) => boolean) | undefined
): boolean {
  if (!context.events.has(key)) {
    return false
  }
  const filters = matchesFilter ? context.filters.get(key) : undefined
  return !filters || filters.some((filter) => matchesFilter?.(filter))
}

function isFrame(context: FrameContext, frame: Electron.WebFrameMain | undefined): boolean {
  return context.processId === frame?.processId && context.routingId === frame.routingId
}

function groupFrames(
  frames: Map<string, FrameContext>,
  visit?: (context: FrameContext) => void
): Map<string, Map<string, FrameContext>> {
  const groups = new Map<string, Map<string, FrameContext>>()
  for (const [key, context] of frames) {
    let group = groups.get(context.extensionId)
    if (!group) {
      group = new Map()
      groups.set(context.extensionId, group)
    }
    group.set(key, context)
    visit?.(context)
  }
  return groups
}

function deliverToFrames(
  state: HostSessionState,
  candidates: Map<string, FrameContext>,
  extensionId: string,
  key: string,
  payload: BrowserExtensionEventPayload,
  matchesFilter: ((filter: unknown) => boolean) | undefined,
  exceptFrame: Electron.WebFrameMain | undefined
): void {
  const origin = `${getChromeExtensionOrigin(extensionId)}/`
  const visited = new Set<FrameContext>()
  const revision = browserExtensionFrameRevision(state.frames)
  let live = false
  let iterator = candidates[Symbol.iterator]()
  while (true) {
    if (!live && revision !== browserExtensionFrameRevision(state.frames)) {
      // Preserve live Map iteration if a synchronous callback changes frame ownership.
      iterator = state.frames[Symbol.iterator]()
      live = true
    }
    const next = iterator.next()
    if (next.done) {
      return
    }
    const [frameKey, context] = next.value
    if (visited.has(context)) {
      continue
    }
    visited.add(context)
    if (
      context.extensionId !== extensionId ||
      isFrame(context, exceptFrame) ||
      !listensFor(context, key, matchesFilter)
    ) {
      continue
    }
    const frame = webFrameMain.fromId(context.processId, context.routingId)
    if (!frame || frame.isDestroyed() || !frame.url.startsWith(origin)) {
      forgetBrowserExtensionFrame(state.frames, frameKey, context)
      continue
    }
    try {
      frame.send(BROWSER_EXTENSION_EVENT_CHANNEL, payload)
    } catch {
      forgetBrowserExtensionFrame(state.frames, frameKey, context)
    }
  }
}

export function dispatchBrowserExtensionEvent(
  sessions: ReadonlyMap<Electron.Session, HostSessionState>,
  target: BrowserExtensionEventTarget,
  namespace: string,
  event: string,
  args: BrowserExtensionEventArgs,
  startWorker: (sess: Electron.Session, context: WorkerContext) => void,
  matchesFilter?: (filter: unknown) => boolean
): void {
  const permission = getBrowserExtensionNamespace(namespace)?.permission
  const key = eventKey(namespace, event)
  for (const [sess, state] of sessions) {
    if (target.session && target.session !== sess) {
      continue
    }
    const extensionIds = new Set<string>()
    for (const context of state.workers.values()) {
      if (context.events.has(key)) {
        extensionIds.add(context.extensionId)
      }
    }
    let groups = groupFrames(state.frames, (context) => {
      if (context.events.has(key)) {
        extensionIds.add(context.extensionId)
      }
    })
    let revision = browserExtensionFrameRevision(state.frames)
    const currentFrames = (extensionId: string): Map<string, FrameContext> | undefined => {
      const currentRevision = browserExtensionFrameRevision(state.frames)
      if (revision !== currentRevision) {
        groups = groupFrames(state.frames)
        revision = currentRevision
      }
      return groups.get(extensionId)
    }
    for (const extensionId of extensionIds) {
      if (target.extensionId && extensionId !== target.extensionId) {
        continue
      }
      const extension = sess.extensions.getExtension(extensionId)
      if (!extension || !extensionHasNamespacePermission(extension, permission, sess)) {
        continue
      }
      const worker = target.exceptCaller?.fromWorker ? undefined : state.workers.get(extension.id)
      const workerListens = worker ? listensFor(worker, key, matchesFilter) : false
      const exceptFrame = target.exceptCaller?.frame
      const frames = currentFrames(extension.id)
      const frameListens =
        frames !== undefined &&
        Array.from(frames.values()).some(
          (frame) => !isFrame(frame, exceptFrame) && listensFor(frame, key, matchesFilter)
        )
      if (!workerListens && !frameListens) {
        continue
      }
      const resolvedArgs = typeof args === 'function' ? args(extension, sess) : args
      if (!resolvedArgs) {
        continue
      }
      const payload: BrowserExtensionEventPayload = { namespace, event, args: resolvedArgs }
      if (worker && workerListens) {
        deliverToWorker(sess, worker, key, payload, startWorker)
      }
      const recipients = frameListens ? currentFrames(extension.id) : undefined
      if (recipients) {
        deliverToFrames(state, recipients, extension.id, key, payload, matchesFilter, exceptFrame)
      }
    }
  }
}
