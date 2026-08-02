import {
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR,
  assertClipboardTextWriteWithinLimitWithYield,
  isClipboardTextWriteTooLargeError
} from '../../../shared/clipboard-text'
import { InvalidArgumentError } from './core'

export async function assertRpcClipboardTextWriteWithinLimit(text: string): Promise<void> {
  try {
    // Why: large accepted text must yield outside Zod's synchronous parse path
    // while preserving the RPC invalid_argument contract for rejected payloads.
    await assertClipboardTextWriteWithinLimitWithYield(text)
  } catch (error) {
    if (isClipboardTextWriteTooLargeError(error)) {
      throw new InvalidArgumentError(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)
    }
    throw error
  }
}
