import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { BrowserError } from './browser-error'

// Guest presses take Chromium focus; only the hosting pane can restore it (#20595).

/** Await pane readiness, then release when input ends to restore the user's focus. */
export type AgentInputFocusGuard = () => Promise<() => void>

export const AGENT_INPUT_FOCUS_GUARD_CHANNEL = 'browser:agentInputFocusGuard'
export const AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL = 'browser:agentInputFocusGuardReady'

// Wait for the pane to record the user's element before Chromium can move focus.
const PANE_READY_TIMEOUT_MS = 150

export function focusGuardUnavailableError(): BrowserError {
  return new BrowserError(
    'browser_focus_guard_unavailable',
    "Orca could not protect the user's keyboard focus for this page, so the input was not sent. Retry, or show the page first."
  )
}

// Blur commits unfinished IME text; refuse input instead of deferring it into a later composition (#28700).
function userComposingError(): BrowserError {
  return new BrowserError(
    'browser_user_composing',
    'The user is typing with an input method in Orca, so the input was not sent to keep their unfinished text. Retry in a moment.'
  )
}

export async function guardPaneFocusForAgentInput(
  renderer: WebContents,
  browserPageId: string
): Promise<() => void> {
  const token = randomUUID()
  const answer = await new Promise<'ready' | 'unavailable' | 'composing'>((resolve) => {
    const finish = (outcome: 'ready' | 'unavailable' | 'composing'): void => {
      clearTimeout(timer)
      ipcMain.removeListener(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL, onReady)
      resolve(outcome)
    }
    const onReady = (event: Electron.IpcMainEvent, reply: unknown): void => {
      if (
        event.sender.id === renderer.id &&
        reply !== null &&
        typeof reply === 'object' &&
        'token' in reply &&
        reply.token === token
      ) {
        finish('composing' in reply && reply.composing === true ? 'composing' : 'ready')
      }
    }
    const timer = setTimeout(() => finish('unavailable'), PANE_READY_TIMEOUT_MS)
    ipcMain.on(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL, onReady)
    renderer.send(AGENT_INPUT_FOCUS_GUARD_CHANNEL, { browserPageId, token, active: true })
  })
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    if (!renderer.isDestroyed()) {
      renderer.send(AGENT_INPUT_FOCUS_GUARD_CHANNEL, { browserPageId, token, active: false })
    }
  }
  if (answer !== 'ready') {
    release()
    throw answer === 'composing' ? userComposingError() : focusGuardUnavailableError()
  }
  return release
}

/** CDP presses measured to move Chromium focus into the guest. */
export function isFocusTakingCdpInput(method: string, params: Record<string, unknown>): boolean {
  switch (method) {
    case 'Input.dispatchMouseEvent':
    case 'Input.emulateTouchFromMouseEvent':
      return params.type === 'mousePressed'
    case 'Input.dispatchTouchEvent':
      return params.type === 'touchStart'
    case 'Input.synthesizeTapGesture':
      return true
    default:
      return false
  }
}

// Chromium routes root-session IME composition by window focus.
export function isFocusRoutedCdpInput(method: string): boolean {
  return method === 'Input.imeSetComposition'
}

export function enablePageFocusEmulation(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
  // Suppress blur so restoring user focus does not close page menus; failure is tolerable.
  return send('Emulation.setFocusEmulationEnabled', { enabled: true }).then(
    () => undefined,
    () => undefined
  )
}
