import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { confirmQuitAndStopAllSessions } from './quit-and-stop-all-sessions-prompt'

function showMessageBoxAnswering(response: number) {
  return vi.fn(async (_options: MessageBoxOptions): Promise<MessageBoxReturnValue> => ({
    response,
    checkboxChecked: false
  }))
}

describe('confirmQuitAndStopAllSessions', () => {
  it('confirms only when the user picks Stop Sessions and Quit', async () => {
    await expect(confirmQuitAndStopAllSessions(showMessageBoxAnswering(0))).resolves.toBe(true)
    await expect(confirmQuitAndStopAllSessions(showMessageBoxAnswering(1))).resolves.toBe(false)
  })

  it('makes Cancel the default so Return or Escape never stops running agents', async () => {
    const showMessageBox = showMessageBoxAnswering(1)

    await confirmQuitAndStopAllSessions(showMessageBox)

    const options = showMessageBox.mock.calls[0][0]
    expect(options.buttons).toEqual(['Stop Sessions and Quit', 'Cancel'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
  })
})
