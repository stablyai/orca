import type { WebContents } from 'electron'
import type { BrowserPasswordFieldFocusEvent } from '../../shared/browser-passwords-types'
import { isAgentInjectingInput } from '../browser/agent-input-injection'
import { browserManager } from '../browser/browser-manager'
import { browserPasswordVaultForGuest as vaultForGuest } from './browser-password-vault-access'
import { BROWSER_PASSWORDS_RENDERER_EVENTS } from './browser-password-save-prompts'

export type BrowserPasswordPickerState = {
  focusedField: BrowserPasswordFieldFocusEvent | null
  pickerFocusTransfer: boolean
}

export function attachBrowserPasswordPickerKeyboard(
  guest: WebContents,
  state: BrowserPasswordPickerState
): void {
  guest.on('before-input-event', (event, input) => {
    if (
      input.type !== 'keyDown' ||
      input.key !== 'ArrowDown' ||
      input.control ||
      input.meta ||
      input.alt ||
      input.shift ||
      input.isAutoRepeat ||
      isAgentInjectingInput(guest) ||
      !state.focusedField ||
      !vaultForGuest(guest)
    ) {
      return
    }
    const context = browserManager.getRendererContextForGuest(guest.id)
    if (!context || context.renderer.isDestroyed()) {
      return
    }
    event.preventDefault()
    state.pickerFocusTransfer = true
    context.renderer.focus()
    context.renderer.send(BROWSER_PASSWORDS_RENDERER_EVENTS.fieldFocus, {
      ...state.focusedField,
      keyboardSelection: true
    } satisfies BrowserPasswordFieldFocusEvent)
  })
}
