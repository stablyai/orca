import { isUSKeyboardText } from '../../shared/emulator/emulator-keyboard-frame'

export type EmulatorTextInputPlan =
  | { kind: 'keys' }
  | { kind: 'paste'; text: string; enterCount: number }

/**
 * Key events only type US keyboard text, and only when the guest reads them as a US keyboard
 * (`usKeys`); any other text goes through the guest clipboard. Typed trailing newlines stay Enter
 * presses so "text\n" still submits a field; a paste keeps them as text, like any paste.
 */
export function planEmulatorTextInput(
  text: string,
  options: { paste: boolean; usKeys: boolean }
): EmulatorTextInputPlan {
  if (options.paste) {
    return { kind: 'paste', text: text.replaceAll('\r', ''), enterCount: 0 }
  }
  if (options.usKeys && isUSKeyboardText(text)) {
    return { kind: 'keys' }
  }
  const body = text.replace(/[\r\n]+$/, '')
  const enterCount = (text.slice(body.length).match(/\n/g) ?? []).length
  return { kind: 'paste', text: body.replaceAll('\r', ''), enterCount }
}
