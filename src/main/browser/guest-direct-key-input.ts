import type { WebContents } from 'electron'
import { enablePageFocusEmulation, type AgentInputFocusGuard } from './agent-input-focus-guard'
import { withAgentInputInjection } from './agent-input-injection'
import {
  resolveFocusedFrameRoute,
  settleWithin,
  type GuestSessionCdpSender
} from './guest-focused-frame-route'
import { sendFrameSessionInput } from './guest-frame-input-sessions'
import { planCdpKeyEvent, planInsertText, type GuestEditCommand } from './guest-key-event-plan'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { normalizeCdpPointerButton } from './agent-browser-bridge-mouse'
import { cdpPointerStateFor, releaseCdpPointerButton } from './cdp-pointer-input'
import {
  assertRemoteCliPageAccess,
  trackRemoteCliInput,
  type HeldInputRelease
} from './remote-cli-page-admission'

// Why: Chromium routes main-session CDP key and text input on a <webview> guest by the
// window's focus, so it lands in whatever the user is typing into (#20595). Events sent to
// the guest's own widget reach its page without moving focus.
// See docs/reference/agent-browser-focus-isolation.md.

export type GuestCdpSender = GuestSessionCdpSender

// Why: getType() is 'webview' only for guests hosted in an Orca window; offscreen and
// headless pages have no host frame tree, so CDP input already reaches them.
export function isEmbeddedGuest(webContents: WebContents): boolean {
  return webContents.getType() === 'webview'
}

// Why: sendInputEvent returns before the page handles the event, but CDP input replies only after.
// A task-queue round trip in the page lets callers read the result of what they just typed.
async function waitForPageToHandleInput(send: GuestCdpSender): Promise<void> {
  await settleWithin(
    send('Runtime.evaluate', {
      // Why: a message-channel task, not setTimeout, which hidden pages throttle to once a second.
      expression:
        'new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0) })',
      awaitPromise: true
    }),
    null
  )
}

function runEditCommand(webContents: WebContents, command: GuestEditCommand): void {
  // Why: it runs after awaiting the page, so a host's access may have been revoked meanwhile.
  assertRemoteCliPageAccess(webContents.id)
  switch (command) {
    case 'selectAll':
      webContents.selectAll()
      return
    case 'copy':
      webContents.copy()
      return
    case 'cut':
      webContents.cut()
      return
    case 'paste':
      webContents.paste()
      return
    case 'undo':
      webContents.undo()
      return
    case 'redo':
      webContents.redo()
      return
    case 'delete':
      webContents.delete()
  }
}

const NO_FOCUS_GUARD: AgentInputFocusGuard = async () => () => {}

// Why: the fallback needs the guest natively focused for CDP to reach it; the guard hands the
// user's focus back afterwards, and emulation keeps the page from seeing that as a blur.
async function focusGuestForCdpInput(
  webContents: WebContents,
  send: GuestCdpSender,
  guardFocus: AgentInputFocusGuard
): Promise<() => void> {
  await enablePageFocusEmulation(send)
  const release = await guardFocus()
  webContents.focus()
  return release
}

// Why: CDP input on a cross-site frame's own session reaches that frame without the user's focus.
async function sendToFrameSession(
  webContents: WebContents,
  send: GuestCdpSender,
  sessionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return await withAgentInputInjection(webContents, () =>
    sendFrameSessionInput(webContents, send, sessionId, method, params)
  )
}

/**
 * Delivers a CDP key event to a page. Embedded guests get widget events, or CDP on a focused
 * cross-site frame's own session; anything else keeps the CDP path while borrowing focus.
 */
export async function dispatchPageKeyEvent(
  webContents: WebContents,
  params: Record<string, unknown>,
  send: GuestCdpSender,
  guardFocus: AgentInputFocusGuard = NO_FOCUS_GUARD
): Promise<unknown> {
  if (!isEmbeddedGuest(webContents)) {
    return await send('Input.dispatchKeyEvent', params)
  }
  const route = await resolveFocusedFrameRoute(webContents, send)
  if (route.kind === 'session') {
    // Why: Tab from a frame's last field can move focus out of the guest into Orca's window.
    const isTabDown =
      params.key === 'Tab' && (params.type === 'keyDown' || params.type === 'rawKeyDown')
    const release = isTabDown ? await guardFocus() : () => {}
    try {
      return await sendToFrameSession(
        webContents,
        send,
        route.sessionId,
        'Input.dispatchKeyEvent',
        params
      )
    } finally {
      release()
    }
  }
  const plan = planCdpKeyEvent(params)
  if (plan && route.kind === 'widget') {
    // Why: Tab from the page's last field moves focus out of the guest into Orca's window.
    const release = plan.events.some((event) => event.type === 'keyDown' && event.keyCode === 'Tab')
      ? await guardFocus()
      : () => {}
    try {
      await withAgentInputInjection(webContents, () =>
        // Why: widget events skip the CDP send, so this key is recorded on the page's hold here.
        trackRemoteCliInput(webContents.id, 'Input.dispatchKeyEvent', params, async () => {
          for (const event of plan.events) {
            webContents.sendInputEvent(event)
          }
          if (plan.commands.length > 0 || plan.events.length > 0) {
            await waitForPageToHandleInput(send)
          }
          for (const command of plan.commands) {
            runEditCommand(webContents, command)
          }
        })
      )
    } finally {
      release()
    }
    return {}
  }
  const release = await focusGuestForCdpInput(webContents, send, guardFocus)
  try {
    return await withAgentInputInjection(webContents, () => send('Input.dispatchKeyEvent', params))
  } finally {
    release()
  }
}

/** Lets go of what a revoked host's command left pressed; a key goes where the focus routes it. */
export async function releaseHeldPageInput(
  webContents: WebContents,
  release: HeldInputRelease,
  guardFocus: AgentInputFocusGuard
): Promise<unknown> {
  const send: GuestCdpSender = (method, params, sessionId) =>
    sendGuestCdpCommand(webContents, method, params, sessionId)
  // Why: the command's own debugger lease may already be gone, detaching the debugger.
  const lease = acquireElectronDebugger(webContents)
  try {
    if (release.method === 'Input.dispatchKeyEvent') {
      return await dispatchPageKeyEvent(webContents, release.params, send, guardFocus)
    }
    if (release.method !== 'Input.dispatchMouseEvent') {
      return await send(release.method, release.params)
    }
    const button = normalizeCdpPointerButton(String(release.params.button))
    const state = cdpPointerStateFor(webContents)
    const remaining = { ...state }
    releaseCdpPointerButton(remaining, button)
    // Why the live mask: another caller's button may still be down; reporting none would drop it.
    const result = await send(release.method, { ...release.params, buttons: remaining.buttons })
    releaseCdpPointerButton(state, button)
    return result
  } finally {
    lease.release()
  }
}

export type TextInsertionRoute = {
  deliver: (params: Record<string, unknown>) => Promise<unknown>
  // Why: the fallback holds borrowed focus from routing until delivery; an insert abandoned in
  // between must still give it back.
  release: () => void
}

/**
 * Chooses how Input.insertText reaches a page: guest widget events for embedded guests, else
 * CDP with the guest focused. Call before any DOM.focus replay; the fallback's focus blurs.
 */
export async function routePageTextInsertion(
  webContents: WebContents,
  params: Record<string, unknown>,
  send: GuestCdpSender,
  guardFocus: AgentInputFocusGuard = NO_FOCUS_GUARD
): Promise<TextInsertionRoute> {
  const sendText = (insertParams: Record<string, unknown>): Promise<unknown> =>
    send('Input.insertText', insertParams)
  if (!isEmbeddedGuest(webContents)) {
    webContents.focus()
    return { deliver: sendText, release: () => {} }
  }
  const route = await resolveFocusedFrameRoute(webContents, send)
  if (route.kind === 'session') {
    const { sessionId } = route
    return {
      deliver: (insertParams) =>
        sendToFrameSession(webContents, send, sessionId, 'Input.insertText', insertParams),
      release: () => {}
    }
  }
  const events = planInsertText(params.text)
  if (events && route.kind === 'widget') {
    return {
      deliver: () =>
        withAgentInputInjection(webContents, async () => {
          for (const event of events) {
            webContents.sendInputEvent(event)
          }
          await waitForPageToHandleInput(send)
          return {}
        }),
      release: () => {}
    }
  }
  const release = await focusGuestForCdpInput(webContents, send, guardFocus)
  return {
    deliver: (insertParams) => withAgentInputInjection(webContents, () => sendText(insertParams)),
    release
  }
}
