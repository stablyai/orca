import { describe, expect, it, vi } from 'vitest'
import { raceSftpFileTransferWithAbort } from './ssh-file-transfer-abort'

describe('raceSftpFileTransferWithAbort', () => {
  it('waits for confirmed SFTP close before rejecting an abort', async () => {
    const controller = new AbortController()
    let confirmClose: () => void = () => {}
    const promise = raceSftpFileTransferWithAbort(
      new Promise<void>(() => {}),
      controller.signal,
      (onClose) => {
        confirmClose = onClose
      }
    )

    controller.abort()
    const pending = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled'
      ),
      Promise.resolve('pending')
    ])
    expect(pending).toBe('pending')

    confirmClose()
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      sshChannelCloseConfirmed: true
    })
  })

  it('marks teardown unconfirmed when SFTP never closes', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const promise = raceSftpFileTransferWithAbort(
        new Promise<void>(() => {}),
        controller.signal,
        () => {}
      )
      const outcome = promise.catch((error: Error) => error)

      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcome).resolves.toMatchObject({
        name: 'AbortError',
        sshChannelCloseConfirmed: false
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
