import { describe, expect, it } from 'vitest'
import { sendScrcpyText } from './scrcpy-input-queue'
import { SCRCPY_CLIPBOARD_TEXT_MAX_BYTES } from './scrcpy-control-protocol'
import type { ScrcpyControlTarget } from './scrcpy-stream-session'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only sendControl is read by the queue
const control = { sendControl: () => true } as unknown as ScrcpyControlTarget

describe('sendScrcpyText', () => {
  it('rejects an oversized multiline US-ASCII paste before it reaches adb', async () => {
    const text = `a\n${'b'.repeat(SCRCPY_CLIPBOARD_TEXT_MAX_BYTES)}`
    await expect(sendScrcpyText(control, text, { paste: true })).rejects.toThrow('too long')
  })

  it('refuses a paste burst instead of queueing it behind settle waits', async () => {
    const results = Array.from({ length: 8 }, () =>
      sendScrcpyText(control, 'a\nb', { paste: true }).then(
        () => 'ok',
        () => 'rejected'
      )
    )
    expect(await Promise.all(results)).toContain('rejected')
  })
})
