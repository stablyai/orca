import type { WebContents } from 'electron'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'

type CdpCommand = readonly [method: string, params?: Record<string, unknown>]
/** sessionId is set for events from a child target, such as an out-of-process iframe. */
type CdpListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

export type OffscreenPageCdpSession = {
  /**
   * Sends a command, attaching first if needed, to the page or to the child target with sessionId.
   * Resolves undefined when no session is possible.
   */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: CdpListener): () => void
  dispose(): void
}

/**
 * The page's own CDP session, shared by every offscreen-page feature that needs one. It holds a
 * debugger lease for the page's life and replays each feature's setup commands on every attach,
 * because a DevTools window can take the debugger away and hand it back at any time.
 */
export function createOffscreenPageCdpSession(
  contents: WebContents,
  setup: () => readonly CdpCommand[],
  acquireDebugger: typeof acquireElectronDebugger = acquireElectronDebugger
): OffscreenPageCdpSession {
  let lease: ElectronDebuggerLease | null = null
  let disposed = false
  const listeners = new Set<CdpListener>()

  const onDebuggerMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string
  ): void => {
    const record = typeof params === 'object' && params !== null ? params : {}
    for (const listener of listeners) {
      listener(method, { ...record }, sessionId || undefined)
    }
  }
  const onDetach = (): void => {
    lease?.release()
    lease = null
  }
  const arm = (): boolean => {
    if (lease) {
      return true
    }
    if (disposed || contents.isDestroyed()) {
      return false
    }
    try {
      lease = acquireDebugger(contents)
    } catch {
      // DevTools owns the session; features fall back to native behaviour until it lets go.
      return false
    }
    for (const [method, params] of setup()) {
      void sendDebuggerCommand(contents.debugger, method, params).catch(() => {})
    }
    return true
  }
  // Why re-arm on input: the next user or agent action is when a feature needs its session back.
  const onInput = (): void => void arm()

  contents.debugger.on('message', onDebuggerMessage)
  contents.debugger.on('detach', onDetach)
  contents.on('input-event', onInput)
  arm()

  return {
    async send(method, params, sessionId) {
      if (!arm() || contents.isDestroyed()) {
        return undefined
      }
      return sendDebuggerCommand(contents.debugger, method, params, sessionId)
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      listeners.clear()
      if (!contents.isDestroyed()) {
        contents.debugger.off('message', onDebuggerMessage)
        contents.debugger.off('detach', onDetach)
        contents.off('input-event', onInput)
      }
      lease?.release()
      lease = null
    }
  }
}
