type SubmitKey = Pick<
  KeyboardEvent,
  | 'key'
  | 'code'
  | 'isComposing'
  | 'keyCode'
  | 'shiftKey'
  | 'altKey'
  | 'metaKey'
  | 'ctrlKey'
  | 'repeat'
  | 'defaultPrevented'
  | 'preventDefault'
>

type ChatSubmitPolicy = {
  enterToSend: boolean
  composing: boolean
  dictating: boolean
  submit: (alternate: boolean) => void
}

export function submitMobileChatHardwareReturn(options: ChatSubmitPolicy): void {
  if (options.enterToSend && !options.composing && !options.dictating) {
    options.submit(false)
  }
}

export function submitMobileChatKeyboardEvent(
  key: SubmitKey,
  options: ChatSubmitPolicy & {
    requiresNativeHardwareReturn?: boolean
    primaryModifier: 'Meta' | 'Control'
  }
): void {
  if (
    key.defaultPrevented ||
    key.key !== 'Enter' ||
    key.isComposing ||
    key.keyCode === 229 ||
    options.composing ||
    options.dictating ||
    key.shiftKey ||
    key.altKey
  ) {
    return
  }
  const alternate =
    options.primaryModifier === 'Meta' ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey
  // iOS needs UIKit provenance; Android's soft keyboard has no physical code.
  const hardwareReturn =
    !options.requiresNativeHardwareReturn && (key.code === 'Enter' || key.code === 'NumpadEnter')
  if (!alternate && !(options.enterToSend && hardwareReturn && !key.metaKey && !key.ctrlKey)) {
    return
  }
  key.preventDefault()
  if (!key.repeat) {
    options.submit(alternate)
  }
}
