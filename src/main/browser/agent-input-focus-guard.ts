import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { BrowserError } from './browser-error'

// Why: any press on a <webview> guest moves Chromium focus into it, whatever path dispatches it,
// and input that only CDP can express needs the guest focused. Only the pane hosting the guest
// can put the user's focus back afterwards (#20595).
// See docs/reference/agent-browser-focus-isolation.md.

/** Resolves once the hosting pane holds the user's focus; call the result when the input ends. */
export type AgentInputFocusGuard = () => Promise<() => void>

export const AGENT_INPUT_FOCUS_GUARD_CHANNEL = 'browser:agentInputFocusGuard'
export const AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL = 'browser:agentInputFocusGuardReady'

// Why: the guard and Chromium's focus move reach the pane on separate pipes, so the input waits
// for the pane to note the user's element first. Without an answer the input is refused.
const PANE_READY_TIMEOUT_MS = 150

export function focusGuardUnavailableError(): BrowserError {
  return new BrowserError(
    'browser_focus_guard_unavailable',
    "Orca could not protect the user's keyboard focus for this page, so the input was not sent. Retry, or show the page first."
  )
}

// Why: blurring the user's open IME composition commits its unfinished text (#28700). Refused
// rather than held: a held press could outlive its agent or land in the user's next composition.
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
    // Why: input sent without a pane holding the user's element would take their focus for good.
    release()
    throw answer === 'composing' ? userComposingError() : focusGuardUnavailableError()
  }
  return release
}

/** CDP input that makes Chromium focus the guest (measured: mouse, touch and tap presses). */
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

// Why: Chromium routes IME composition on a guest's root session by window focus, like key input.
export function isFocusRoutedCdpInput(method: string): boolean {
  return method === 'Input.imeSetComposition'
}

/** Makes the page treat itself as focused while Orca's window keeps the user's real focus. */
export function enablePageFocusEmulation(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
  // Why: when the user's focus comes back the page would see blur and close the menu or picker
  // the agent just opened. Best effort: a page without it only loses that nicety.
  return send('Emulation.setFocusEmulationEnabled', { enabled: true }).then(
    () => undefined,
    () => undefined
  )
}
