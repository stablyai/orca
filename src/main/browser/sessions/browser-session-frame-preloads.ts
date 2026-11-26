import type { Session } from 'electron'
import { findBundledMainFile } from '../bundled-main-file-path'

const registeredSessionsById = new Map<string, WeakSet<Session>>()

/** Runs a bundled preload in every frame of the session's pages, once per session. False when it is missing. */
export function registerBrowserSessionFramePreload(
  browserSession: Session,
  id: string,
  fileName: string
): boolean {
  const registered = registeredSessionsById.get(id) ?? new WeakSet<Session>()
  registeredSessionsById.set(id, registered)
  if (registered.has(browserSession)) {
    return true
  }
  const filePath = findBundledMainFile(fileName)
  if (!filePath) {
    return false
  }
  // Why frame only: a service-worker preload crashes the renderer during GC (electron#52310).
  browserSession.registerPreloadScript({ id, type: 'frame', filePath })
  registered.add(browserSession)
  return true
}

export function unregisterBrowserSessionFramePreload(browserSession: Session, id: string): void {
  if (registeredSessionsById.get(id)?.delete(browserSession)) {
    browserSession.unregisterPreloadScript(id)
  }
}
