import { describe, expect, it, vi } from 'vitest'
import { raceSftpFileTransferWithAbort } from './ssh-file-transfer-abort'

describe('raceSftpFileTransferWithAbort', () => {
  it('joins confirmed SFTP close and transfer teardown before rejecting an abort', async () => {
    const controller = new AbortController()
    let confirmClose: () => void = () => {}
    let settleTransfer: () => void = () => {}
    const promise = raceSftpFileTransferWithAbort(
      new Promise<void>((resolve) => {
        settleTransfer = resolve
      }),
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
    const stillPending = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled'
      ),
      Promise.resolve('pending')
    ])
    expect(stillPending).toBe('pending')

    settleTransfer()
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      sshChannelCloseConfirmed: true,
      sshTransferTeardownConfirmed: true
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
        sshChannelCloseConfirmed: false,
        sshTransferTeardownConfirmed: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks transfer teardown unconfirmed when close wins but the transfer never settles', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const promise = raceSftpFileTransferWithAbort(
        new Promise<void>(() => {}),
        controller.signal,
        (onClose) => onClose()
      )
      const outcome = promise.catch((error: Error) => error)

      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcome).resolves.toMatchObject({
        name: 'AbortError',
        sshChannelCloseConfirmed: true,
        sshTransferTeardownConfirmed: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the close waiter when the teardown deadline expires', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const removeCloseListener = vi.fn()
      const outcome = raceSftpFileTransferWithAbort(
        new Promise<void>(() => {}),
        controller.signal,
        () => removeCloseListener
      ).catch((error: Error) => error)

      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcome).resolves.toMatchObject({
        sshTransferTeardownConfirmed: false
      })
      expect(removeCloseListener).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
