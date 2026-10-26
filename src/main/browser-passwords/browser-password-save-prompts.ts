import { randomUUID } from 'node:crypto'
import type {
  BrowserPasswordSavePrompt,
  BrowserPasswordSavePromptResponse
} from '../../shared/browser-passwords-types'
import { browserManager } from '../browser/browser-manager'
import type { BrowserPasswordSucceededLogin } from './browser-password-login-tracker'
import { decideBrowserPasswordSave } from './browser-password-save-decision'
import type { BrowserPasswordStore } from './browser-password-store'
import { browserPasswordVaultFor } from './browser-password-vault-access'

export const BROWSER_PASSWORDS_RENDERER_EVENTS = {
  savePrompt: 'browserPasswords:savePrompt',
  savePromptClosed: 'browserPasswords:savePromptClosed',
  fieldFocus: 'browserPasswords:fieldFocus',
  fieldBlur: 'browserPasswords:fieldBlur'
} as const

type PendingPrompt = {
  prompt: BrowserPasswordSavePrompt
  guestId: number
  browserProfileId: string
  password: string
  existingEntryId: string | null
  expireTimer: NodeJS.Timeout
}

// Chrome keeps the save offer reachable from the key icon until the user moves on; five minutes here.
const SAVE_PROMPT_TTL_MS = 5 * 60 * 1000

// Why main keeps the password: the renderer only ever learns the site and username of an offer.
const prompts = new Map<string, PendingPrompt>()

/** Offers to save or update a login that worked, unless it is already saved or the site said never. */
export function offerBrowserPasswordSave(input: {
  guestId: number
  browserProfileId: string
  vault: BrowserPasswordStore
  login: BrowserPasswordSucceededLogin
}): void {
  const { vault, login } = input
  const password = login.capture.newPassword ?? login.capture.password
  const never = vault.isNever(login.origin)
  if (!password || !never.ok || never.value) {
    return
  }
  const matches = vault.findForOrigin(login.origin)
  if (!matches.ok) {
    return
  }
  const saved = matches.value.exact.flatMap((entry) => {
    const stored = vault.getPassword(entry.id)
    return stored.ok ? [{ id: entry.id, username: entry.username, password: stored.value }] : []
  })
  const decision = decideBrowserPasswordSave({
    username: login.username,
    password,
    formKind: login.capture.kind,
    saved
  })
  if (decision.kind === 'none') {
    if (decision.usedEntryId) {
      vault.markUsed(decision.usedEntryId)
    }
    return
  }
  const context = browserManager.getRendererContextForGuest(input.guestId)
  if (!context) {
    return
  }
  // One offer per page: a newer login replaces the one the user hasn't answered yet.
  for (const [promptId, pending] of prompts) {
    if (pending.prompt.browserPageId === context.browserPageId) {
      closePrompt(promptId)
    }
  }
  const prompt: BrowserPasswordSavePrompt = {
    promptId: randomUUID(),
    browserPageId: context.browserPageId,
    origin: login.origin,
    username: decision.username,
    mode: decision.kind
  }
  prompts.set(prompt.promptId, {
    prompt,
    guestId: input.guestId,
    browserProfileId: input.browserProfileId,
    password: decision.password,
    existingEntryId: decision.kind === 'update' ? decision.entryId : null,
    expireTimer: setTimeout(() => closePrompt(prompt.promptId), SAVE_PROMPT_TTL_MS)
  })
  context.renderer.send(BROWSER_PASSWORDS_RENDERER_EVENTS.savePrompt, prompt)
}

function closePrompt(promptId: string): void {
  const pending = prompts.get(promptId)
  if (!pending) {
    return
  }
  prompts.delete(promptId)
  clearTimeout(pending.expireTimer)
  const context = browserManager.getRendererContextForGuest(pending.guestId)
  if (context && !context.renderer.isDestroyed()) {
    context.renderer.send(BROWSER_PASSWORDS_RENDERER_EVENTS.savePromptClosed, { promptId })
  }
}

export function closeBrowserPasswordSavePromptsForGuest(guestId: number): void {
  for (const [promptId, pending] of prompts) {
    if (pending.guestId === guestId) {
      closePrompt(promptId)
    }
  }
}

export function respondToBrowserPasswordSavePrompt(
  response: BrowserPasswordSavePromptResponse
): boolean {
  const pending = prompts.get(response.promptId)
  if (!pending) {
    return false
  }
  closePrompt(response.promptId)
  if (response.action === 'dismiss') {
    return true
  }
  const vault = browserPasswordVaultFor(pending.browserProfileId)
  if (response.action === 'never') {
    return vault.addNever(pending.prompt.origin).ok
  }
  if (pending.existingEntryId) {
    return vault.updatePassword(pending.existingEntryId, pending.password).ok
  }
  const username = (response.username ?? pending.prompt.username).trim()
  return vault.add({ origin: pending.prompt.origin, username, password: pending.password }).ok
}
