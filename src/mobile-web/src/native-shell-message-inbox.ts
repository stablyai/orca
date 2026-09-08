export const MOBILE_WEB_SHELL_LISTENING_PROPERTY = '__orcaMobileWebShellListening'
export const MOBILE_WEB_SHELL_PENDING_PROPERTY = '__orcaMobileWebShellPending'

type MobileWebShellMessageWindow = Window & {
  [MOBILE_WEB_SHELL_LISTENING_PROPERTY]?: boolean
  [MOBILE_WEB_SHELL_PENDING_PROPERTY]?: string[]
}

export function subscribeToMobileWebShellMessages(
  target: MobileWebShellMessageWindow,
  receive: (raw: string) => void
): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (event.source === null && typeof event.data === 'string') {
      receive(event.data)
    }
  }

  target.addEventListener('message', handleMessage)
  target[MOBILE_WEB_SHELL_LISTENING_PROPERTY] = true
  const pending = target[MOBILE_WEB_SHELL_PENDING_PROPERTY]?.splice(0) ?? []
  for (const raw of pending) {
    receive(raw)
  }

  return () => {
    target[MOBILE_WEB_SHELL_LISTENING_PROPERTY] = false
    target.removeEventListener('message', handleMessage)
  }
}
