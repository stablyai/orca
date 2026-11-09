import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR,
  assertClipboardTextWriteWithinLimit,
  assertClipboardTextWriteWithinLimitWithYield,
  isClipboardTextWriteTooLargeError
} from '../../shared/clipboard-text'
import { RuntimeClientError } from './runtime-client-error'

export function validateComputerClipboardPasteText(text: string): void {
  try {
    assertClipboardTextWriteWithinLimit(text)
  } catch (error) {
    if (isClipboardTextWriteTooLargeError(error)) {
      throw new RuntimeClientError('invalid_argument', CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)
    }
    throw error
  }
}

export async function validateComputerClipboardPasteTextWithYield(text: string): Promise<void> {
  try {
    // Yield while measuring large payloads so validation does not monopolize the process.
    await assertClipboardTextWriteWithinLimitWithYield(text)
  } catch (error) {
    if (isClipboardTextWriteTooLargeError(error)) {
      throw new RuntimeClientError('invalid_argument', CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)
    }
    throw error
  }
}

export function validateComputerClipboardPasteTextWithBoundedYield(
  text: string
): Promise<void> | void {
  if (text.length <= CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS) {
    validateComputerClipboardPasteText(text)
    return
  }
  return validateComputerClipboardPasteTextWithYield(text)
}
