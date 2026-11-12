import { assertExpectedPageUrlForStep } from './browser-expected-page-url'
import type { WebContents } from 'electron'
import type { AgentInputFocusGuard } from './agent-input-focus-guard'
import { BrowserError } from '../../browser-error'
import { withAgentInputInjection } from './agent-input-injection'
import { resolveFocusedFrameRoute } from './guest-focused-frame-route'
import {
  settleWithin,
  type GuestSessionCdpSender,
  sendFrameSessionInput
} from './guest-frame-input-sessions'
import { planCdpKeyEvent, type GuestEditCommand } from './guest-key-event-plan'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
import { acquireElectronDebugger } from '../debugger/electron-debugger-lease'
import { normalizeCdpPointerButton } from './cdp-pointer-targets'
import { cdpPointerStateFor, releaseCdpPointerButton } from './cdp-pointer-input'
import {
  assertRemoteCliPageAccess,
  trackRemoteCliInput,
  type HeldInputRelease
} from '../../routing/input-ownership/remote-cli-page-admission'

// Main-session CDP keys follow window focus; guest widget events protect the user's input (#20595).

// Offscreen and headless pages lack a host frame tree, so CDP already targets them.
export function isEmbeddedGuest(webContents: WebContents): boolean {
  return webContents.getType() === 'webview'
}

// Wait for widget input handling before callers read its effects, matching CDP behavior.
async function waitForPageToHandleInput(send: GuestSessionCdpSender): Promise<void> {
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

export function pageInputRouteUnavailableError(): BrowserError {
  return new BrowserError(
    'browser_input_target_unavailable',
    'Input could not be routed directly to the browser page, so it was not sent.'
  )
}

// Cross-site frame sessions route CDP input without borrowing user focus.
async function sendToFrameSession(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  sessionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return await withAgentInputInjection(webContents, () =>
    sendFrameSessionInput(webContents, send, sessionId, method, params)
  )
}

/** Guest input must target its widget or frame session without borrowing window focus. */
export async function dispatchPageKeyEvent(
  webContents: WebContents,
  params: Record<string, unknown>,
  send: GuestSessionCdpSender,
  guardFocus: AgentInputFocusGuard = NO_FOCUS_GUARD
): Promise<unknown> {
  return await dispatchPageKeyEvents(webContents, [params], send, guardFocus)
}

const isTabDown = (params: Record<string, unknown>): boolean =>
  params.key === 'Tab' && (params.type === 'keyDown' || params.type === 'rawKeyDown')

/** Deliver a run of key events along one focus route; callers split runs where focus may move. */
export async function dispatchPageKeyEvents(
  webContents: WebContents,
  events: readonly Record<string, unknown>[],
  send: GuestSessionCdpSender,
  guardFocus: AgentInputFocusGuard = NO_FOCUS_GUARD
): Promise<unknown> {
  let result: unknown = {}
  if (!isEmbeddedGuest(webContents)) {
    assertExpectedPageUrlForStep()
    for (const params of events) {
      result = await send('Input.dispatchKeyEvent', params)
    }
    return result
  }
  let start = 0
  let route = await resolveFocusedFrameRoute(webContents, send)
  // Once per run, after finding the route: a page that rewrites its URL per key still types its run.
  assertExpectedPageUrlForStep()
  // A frame's key handler can move focus to another frame, so each key finds its route again.
  while (route.kind === 'session') {
    const keyUp = events.findIndex((params, index) => index >= start && params.type === 'keyUp')
    const end = keyUp === -1 ? events.length : keyUp + 1
    const key = events.slice(start, end)
    // Tab from the last frame field can escape into Orca's window.
    const release = key.some(isTabDown) ? await guardFocus() : () => {}
    try {
      for (const params of key) {
        result = await sendToFrameSession(
          webContents,
          send,
          route.sessionId,
          'Input.dispatchKeyEvent',
          params
        )
      }
    } finally {
      release()
    }
    if (end >= events.length) {
      return result
    }
    start = end
    route = await resolveFocusedFrameRoute(webContents, send)
  }
  const remaining = events.slice(start)
  const plans = remaining.map((params) => planCdpKeyEvent(params))
  if (route.kind === 'widget' && plans.every((plan) => plan !== null)) {
    // Tab from the last page field can escape into Orca's window.
    const release = remaining.some(isTabDown) ? await guardFocus() : () => {}
    try {
      await withAgentInputInjection(webContents, async () => {
        // One page round trip settles the whole run; edit commands must see the keys before them.
        let unsettled = false
        for (const [index, plan] of plans.entries()) {
          // Widget events bypass CDP send, so track held keys here.
          await trackRemoteCliInput(
            webContents.id,
            'Input.dispatchKeyEvent',
            remaining[index],
            async () => {
              for (const event of plan.events) {
                webContents.sendInputEvent(event)
              }
              unsettled ||= plan.events.length > 0
              if (plan.commands.length > 0) {
                await waitForPageToHandleInput(send)
                unsettled = false
                for (const command of plan.commands) {
                  runEditCommand(webContents, command)
                }
              }
            }
          )
        }
        if (unsettled) {
          await waitForPageToHandleInput(send)
        }
      })
    } finally {
      release()
    }
    return {}
  }
  throw pageInputRouteUnavailableError()
}

/** Release input held by a revoked host, routing keys to the focused frame. */
export async function releaseHeldPageInput(
  webContents: WebContents,
  release: HeldInputRelease,
  guardFocus: AgentInputFocusGuard
): Promise<unknown> {
  const send: GuestSessionCdpSender = (method, params, sessionId) =>
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
}

/** Native insertion targets the guest even when another tab or the host has focus. */
export async function routePageTextInsertion(
  webContents: WebContents,
  send: GuestSessionCdpSender
): Promise<TextInsertionRoute> {
  const sendText = (insertParams: Record<string, unknown>): Promise<unknown> =>
    send('Input.insertText', insertParams)
  if (!isEmbeddedGuest(webContents)) {
    return { deliver: sendText }
  }
  const route = await resolveFocusedFrameRoute(webContents, send)
  if (route.kind === 'session') {
    const { sessionId } = route
    return {
      deliver: (insertParams) =>
        sendToFrameSession(webContents, send, sessionId, 'Input.insertText', insertParams)
    }
  }
  if (route.kind === 'widget' && route.hasFocusedLocalFrame) {
    return {
      deliver: (insertParams) =>
        withAgentInputInjection(webContents, async () => {
          assertExpectedPageUrlForStep()
          if (typeof insertParams.text !== 'string') {
            throw new BrowserError('invalid_argument', 'Browser text must be a string')
          }
          await insertGuestText(webContents, insertParams.text)
          await waitForPageToHandleInput(send)
          return {}
        })
    }
  }
  if (route.kind === 'unknown') {
    throw pageInputRouteUnavailableError()
  }
  throw new BrowserError(
    'browser_input_target_unavailable',
    'The browser page has no focused element to receive text, so it was not sent. Focus a field first.'
  )
}

const NATIVE_INSERT_TIMEOUT_MS = 10_000

// Electron's insertText never settles if the renderer dies, so bound it to keep input queues moving.
async function insertGuestText(webContents: WebContents, text: string): Promise<void> {
  let stop = (): void => {}
  const abandoned = new Promise<never>((_resolve, reject) => {
    const fail = (): void =>
      reject(
        new BrowserError(
          'browser_error',
          'The browser page crashed or closed before it confirmed the text.'
        )
      )
    const timer = setTimeout(
      () =>
        reject(
          new BrowserError('browser_timeout', 'The browser page did not confirm the text in time.')
        ),
      NATIVE_INSERT_TIMEOUT_MS
    )
    webContents.once('render-process-gone', fail)
    webContents.once('destroyed', fail)
    stop = () => {
      clearTimeout(timer)
      webContents.removeListener('render-process-gone', fail)
      webContents.removeListener('destroyed', fail)
    }
  })
  const inserted = webContents.insertText(text)
  // Settle a late rejection after the bound has already answered.
  inserted.catch(() => undefined)
  try {
    await Promise.race([inserted, abandoned])
  } finally {
    stop()
  }
}
