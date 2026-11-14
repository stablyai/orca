import { describe, expect, it } from 'vitest'
import { abandonRemoteSessionScanOnCancel } from './ai-vault-scan-cancellation'

describe('abandonRemoteSessionScanOnCancel', () => {
  it('stops waiting on a scan that has no transport-level abort', async () => {
    const controller = new AbortController()
    const pending = abandonRemoteSessionScanOnCancel(
      new Promise<string>(() => {}),
      controller.signal
    )

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
