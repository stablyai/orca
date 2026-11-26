import { validateComputerClipboardPasteTextWithBoundedYield } from './computer-clipboard-paste-validation'

export function validateComputerSidecarPasteText(
  method: string,
  params: unknown
): Promise<void> | void {
  if (method !== 'pasteText' || !params || typeof params !== 'object') {
    return
  }
  const text = (params as Record<string, unknown>).text
  if (typeof text !== 'string') {
    return
  }
  return validateComputerClipboardPasteTextWithBoundedYield(text)
}
