import { ipcRenderer } from 'electron'

type PanelPushListener = (push: unknown) => void

const PANEL_PUSH_CHANNEL = 'plugins:panelPush'
const listenersByToken = new Map<string, Set<PanelPushListener>>()
let routing = false

function route(): void {
  if (routing) {
    return
  }
  routing = true
  ipcRenderer.on(PANEL_PUSH_CHANNEL, (_event, message: unknown) => {
    const token =
      typeof message === 'object' && message !== null && 'sessionToken' in message
        ? message.sessionToken
        : null
    const push =
      typeof message === 'object' && message !== null && 'push' in message ? message.push : null
    for (const listener of typeof token === 'string' ? (listenersByToken.get(token) ?? []) : []) {
      listener(push)
    }
  })
}

/** Frames of one session share its channel; it opens with the first and closes with the last. */
export function subscribePluginPanelPush(
  sessionToken: string,
  listener: PanelPushListener
): () => void {
  route()
  let listeners = listenersByToken.get(sessionToken)
  if (!listeners) {
    listeners = new Set()
    listenersByToken.set(sessionToken, listeners)
    void ipcRenderer.invoke('plugins:openPanelPush', { sessionToken }).catch(() => undefined)
  }
  listeners.add(listener)
  return () => {
    const current = listenersByToken.get(sessionToken)
    if (!current?.delete(listener) || current.size > 0) {
      return
    }
    listenersByToken.delete(sessionToken)
    void ipcRenderer.invoke('plugins:closePanelPush', { sessionToken }).catch(() => undefined)
  }
}
