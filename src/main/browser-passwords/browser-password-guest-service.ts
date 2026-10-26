import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  BROWSER_PASSWORDS_GUEST_CHANNELS,
  BROWSER_PASSWORDS_TO_GUEST_CHANNELS,
  type BrowserPasswordFieldBlurEvent,
  type BrowserPasswordFieldFocusEvent,
  type BrowserPasswordFillOutcome,
  type BrowserPasswordFillRequest,
  type BrowserPasswordFillResult,
  type BrowserPasswordGuestFieldFocused,
  type BrowserPasswordSuggestion
} from '../../shared/browser-passwords-types'
import { browserManager } from '../browser/browser-manager'
import { BrowserPasswordLoginTracker } from './browser-password-login-tracker'
import { toBrowserPasswordOrigin } from './browser-password-origin'
import {
  BROWSER_PASSWORDS_RENDERER_EVENTS,
  closeBrowserPasswordSavePromptsForGuest,
  offerBrowserPasswordSave
} from './browser-password-save-prompts'
import { confirmBrowserPasswordOwner } from './browser-password-reauth'
import {
  browserPasswordSettings,
  browserPasswordVaultForGuest as vaultForGuest,
  setBrowserPasswordSettingsSource,
  type BrowserPasswordSettings
} from './browser-password-vault-access'
import {
  readBrowserPasswordCapture,
  readBrowserPasswordFieldFocused,
  readBrowserPasswordFillResult,
  readBrowserPasswordFormSummaries,
  readBrowserPasswordSubmitted,
  readBrowserPasswordToken
} from './browser-password-guest-payloads'

type GuestState = {
  guest: WebContents
  tracker: BrowserPasswordLoginTracker
  focusedFieldToken: string | null
}

type PendingFill = {
  resolve: (result: BrowserPasswordFillResult) => void
  timer: NodeJS.Timeout
}

const FILL_REPLY_TIMEOUT_MS = 3000

const guests = new Map<number, GuestState>()
const pendingFills = new Map<string, PendingFill>()
let guestHandlersInstalled = false

export function configureBrowserPasswords(readSettings: () => BrowserPasswordSettings): void {
  setBrowserPasswordSettingsSource(readSettings)
  installGuestHandlers()
}

/** Starts password detection for a browsing guest; documents opt in on every dom-ready. */
export function attachBrowserPasswordGuest(guest: WebContents): void {
  if (guests.has(guest.id)) {
    return
  }
  const state: GuestState = {
    guest,
    tracker: new BrowserPasswordLoginTracker({
      onLoginSucceeded: (login) => {
        const target = vaultForGuest(guest)
        if (target && browserPasswordSettings().offerToSave) {
          offerBrowserPasswordSave({ guestId: guest.id, ...target, login })
        }
      },
      schedule: (delayMs, run) => {
        const timer = setTimeout(run, delayMs)
        return () => clearTimeout(timer)
      },
      now: Date.now
    }),
    focusedFieldToken: null
  }
  guests.set(guest.id, state)

  guest.on('dom-ready', () => {
    state.tracker.documentReady()
    if (vaultForGuest(guest)) {
      guest.send(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.enable)
    }
  })
  guest.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) {
      return
    }
    clearFocus(state)
    // Address-bar, back/forward and Orca reloads carry no initiating frame; page navigations do.
    state.tracker.navigationStarted(details.initiator != null)
  })
  guest.on('did-navigate', (_event, _url, httpResponseCode) => {
    state.tracker.navigated(httpResponseCode)
  })
  guest.once('destroyed', () => {
    state.tracker.dispose()
    guests.delete(guest.id)
    closeBrowserPasswordSavePromptsForGuest(guest.id)
  })
}

/** On a setting change: open pages start or stop now, not at their next load. */
export function applyBrowserPasswordSettingsToGuests(): void {
  for (const state of guests.values()) {
    if (state.guest.isDestroyed()) {
      continue
    }
    if (vaultForGuest(state.guest)) {
      state.guest.send(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.enable)
      continue
    }
    state.tracker.dispose()
    clearFocus(state)
    closeBrowserPasswordSavePromptsForGuest(state.guest.id)
    state.guest.send(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.disable)
  }
}

/** The guest state for a message only if it came from that guest's top frame, with its origin. */
function guestMessageContext(event: IpcMainEvent): { state: GuestState; origin: string } | null {
  const state = guests.get(event.sender.id)
  const frame = event.senderFrame
  if (!state || !frame || frame !== state.guest.mainFrame || !vaultForGuest(state.guest)) {
    return null
  }
  // Why the frame's committed origin and never the payload: a page can claim any site it likes.
  const origin = toBrowserPasswordOrigin(frame.origin)
  return origin ? { state, origin } : null
}

function installGuestHandlers(): void {
  if (guestHandlersInstalled) {
    return
  }
  guestHandlersInstalled = true
  const channels = BROWSER_PASSWORDS_GUEST_CHANNELS
  ipcMain.on(channels.typed, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const capture = readBrowserPasswordCapture(payload)
    if (context && capture) {
      context.state.tracker.typed(context.origin, capture)
    }
  })
  ipcMain.on(channels.submitted, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const submitted = readBrowserPasswordSubmitted(payload)
    if (context && submitted) {
      context.state.tracker.submitted(context.origin, submitted)
    }
  })
  ipcMain.on(channels.formGone, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const formSignature = readBrowserPasswordToken(payload, 'formSignature')
    if (context && formSignature) {
      context.state.tracker.formGone(formSignature)
    }
  })
  ipcMain.on(channels.pageForms, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const forms = readBrowserPasswordFormSummaries(payload)
    if (context && forms) {
      context.state.tracker.pageForms(forms)
    }
  })
  ipcMain.on(channels.fieldFocused, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const focused = readBrowserPasswordFieldFocused(payload)
    if (context && focused) {
      showSuggestions(context.state, context.origin, focused)
    }
  })
  ipcMain.on(channels.fieldBlurred, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const fieldToken = readBrowserPasswordToken(payload, 'fieldToken')
    if (context && fieldToken && context.state.focusedFieldToken === fieldToken) {
      clearFocus(context.state)
    }
  })
  ipcMain.on(channels.fillResult, (event, payload: unknown) => {
    const context = guestMessageContext(event)
    const result = readBrowserPasswordFillResult(payload)
    const pending = result ? pendingFills.get(result.requestId) : undefined
    if (context && result && pending) {
      pendingFills.delete(result.requestId)
      clearTimeout(pending.timer)
      pending.resolve(result)
    }
  })
}

function showSuggestions(
  state: GuestState,
  origin: string,
  focused: BrowserPasswordGuestFieldFocused
): void {
  // No password generation in v1, so a new-password field has nothing to offer.
  if (focused.role === 'new-password') {
    return
  }
  const target = vaultForGuest(state.guest)
  const matches = target?.vault.findForOrigin(origin)
  if (!target || !matches?.ok) {
    return
  }
  const suggestions: BrowserPasswordSuggestion[] = [
    ...matches.value.exact.map((entry) => ({ entry, exactOrigin: true })),
    ...matches.value.sameSite.map((entry) => ({ entry, exactOrigin: false }))
  ].map(({ entry, exactOrigin }) => ({
    entryId: entry.id,
    username: entry.username,
    origin: entry.origin,
    exactOrigin
  }))
  if (suggestions.length === 0) {
    return
  }
  const context = browserManager.getRendererContextForGuest(state.guest.id)
  if (!context) {
    return
  }
  state.focusedFieldToken = focused.fieldToken
  const payload: BrowserPasswordFieldFocusEvent = {
    browserPageId: context.browserPageId,
    fieldToken: focused.fieldToken,
    role: focused.role,
    rect: focused.rect,
    viewportWidth: focused.viewportWidth,
    suggestions
  }
  context.renderer.send(BROWSER_PASSWORDS_RENDERER_EVENTS.fieldFocus, payload)
}

function clearFocus(state: GuestState): void {
  const fieldToken = state.focusedFieldToken
  if (!fieldToken) {
    return
  }
  state.focusedFieldToken = null
  const context = browserManager.getRendererContextForGuest(state.guest.id)
  if (context) {
    const payload: BrowserPasswordFieldBlurEvent = {
      browserPageId: context.browserPageId,
      fieldToken
    }
    context.renderer.send(BROWSER_PASSWORDS_RENDERER_EVENTS.fieldBlur, payload)
  }
}

/** Fills one saved login into the field the user picked it for, after Orca's own UI was clicked. */
export async function fillBrowserPassword(input: {
  browserPageId: string
  fieldToken: string
  entryId: string
}): Promise<BrowserPasswordFillOutcome> {
  const guestId = browserManager.getGuestWebContentsId(input.browserPageId)
  const state = guestId === null ? undefined : guests.get(guestId)
  const target = state ? vaultForGuest(state.guest) : null
  if (!state || !target || state.guest.isDestroyed()) {
    return { ok: false, reason: 'unavailable' }
  }
  // Why recheck now: the page may have navigated between showing the list and the click.
  const origin = toBrowserPasswordOrigin(state.guest.mainFrame.origin)
  const matches = origin ? target.vault.findForOrigin(origin) : null
  const entry = matches?.ok
    ? [...matches.value.exact, ...matches.value.sameSite].find((item) => item.id === input.entryId)
    : undefined
  if (
    entry &&
    browserPasswordSettings().fillRequiresReauth &&
    !(await confirmBrowserPasswordOwner('fill a saved password', { always: true }))
  ) {
    return { ok: false, reason: 'unavailable' }
  }
  const password = entry ? target.vault.getPassword(entry.id) : null
  if (!entry || !password?.ok) {
    return { ok: false, reason: 'unavailable' }
  }
  const request: BrowserPasswordFillRequest = {
    requestId: randomUUID(),
    fieldToken: input.fieldToken,
    username: entry.username || null,
    password: password.value
  }
  const result = await new Promise<BrowserPasswordFillResult>((resolve) => {
    pendingFills.set(request.requestId, {
      resolve,
      timer: setTimeout(() => {
        pendingFills.delete(request.requestId)
        resolve({ requestId: request.requestId, ok: false, reason: 'field-gone' })
      }, FILL_REPLY_TIMEOUT_MS)
    })
    state.guest.mainFrame.send(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.fill, request)
  })
  if (result.ok) {
    target.vault.markUsed(entry.id)
  }
  return result
}
