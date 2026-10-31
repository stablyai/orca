import {
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR,
  assertClipboardTextWriteWithinLimitWithYield,
  isClipboardTextWriteTooLargeError
} from '../../../shared/clipboard-text'
import { InvalidArgumentError } from './core'

export async function assertRpcClipboardTextWriteWithinLimit(text: string): Promise<void> {
  try {
    // Yield for large text outside synchronous Zod parse while preserving invalid_argument refusals.
    await assertClipboardTextWriteWithinLimitWithYield(text)
  } catch (error) {
    if (isClipboardTextWriteTooLargeError(error)) {
      throw new InvalidArgumentError(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)
    }
    throw error
  }
}
