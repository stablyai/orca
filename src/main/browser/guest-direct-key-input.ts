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

// Main-session CDP keys follow window focus; guest widget events protect the user's input (#20595).

export type GuestCdpSender = GuestSessionCdpSender

// Offscreen and headless pages lack a host frame tree, so CDP already targets them.
export function isEmbeddedGuest(webContents: WebContents): boolean {
  return webContents.getType() === 'webview'
}

// Wait for widget input handling before callers read its effects, matching CDP behavior.
async function waitForPageToHandleInput(send: GuestCdpSender): Promise<void> {
  await settleWithin(
    send('Runtime.evaluate', {
      // MessageChannel avoids hidden-page timer throttling.
      expression:
        'new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0) })',
      awaitPromise: true
    }),
    null
  )
}

function runEditCommand(webContents: WebContents, command: GuestEditCommand): void {
  // Access may be revoked while awaiting page input handling.
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

// Restore user focus after CDP fallback; emulation keeps the page from seeing blur.
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

// Cross-site frame sessions route CDP input without borrowing user focus.
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

/** Prefer guest widget or frame-session events; borrow focus for embedded-guest CDP fallback. */
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
    // Tab from the last frame field can escape into Orca's window.
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
    // Tab from the last page field can escape into Orca's window.
    const release = plan.events.some((event) => event.type === 'keyDown' && event.keyCode === 'Tab')
      ? await guardFocus()
      : () => {}
    try {
      await withAgentInputInjection(webContents, () =>
        // Widget events bypass CDP send, so track held keys here.
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

/** Release input held by a revoked host, routing keys to the focused frame. */
export async function releaseHeldPageInput(
  webContents: WebContents,
  release: HeldInputRelease,
  guardFocus: AgentInputFocusGuard
): Promise<unknown> {
  const send: GuestCdpSender = (method, params, sessionId) =>
    sendGuestCdpCommand(webContents, method, params, sessionId)
  // The command's debugger lease may already have detached.
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
    // Preserve other callers' held buttons when releasing this one.
    const result = await send(release.method, { ...release.params, buttons: remaining.buttons })
    releaseCdpPointerButton(state, button)
    return result
  } finally {
    lease.release()
  }
}

export type TextInsertionRoute = {
  deliver: (params: Record<string, unknown>) => Promise<unknown>
  // Release borrowed focus even if delivery is abandoned.
  release: () => void
}

/** Route before DOM.focus replay: CDP fallback can blur the selected element. */
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
