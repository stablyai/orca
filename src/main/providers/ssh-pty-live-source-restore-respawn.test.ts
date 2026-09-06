import { describe, expect, it, vi } from 'vitest'
import {
  SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyAbsentFromRelayError
} from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

const RESTORE_REQUIRED = {
  incarnationId: 'incarnation-1',
  sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
}

function providerWithAttachReplies(replies: unknown[]): {
  provider: SshPtyProvider
  request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn()
  for (const reply of replies) {
    request.mockResolvedValueOnce(reply)
  }
  const mux = {
    request,
    notify: vi.fn(),
    onNotification: vi.fn().mockReturnValue(vi.fn())
  }
  return { provider: new SshPtyProvider('conn-1', mux as never), request }
}

describe('a live PTY whose source delivery needs restoring', () => {
  // The relay only reaches a restoreRequired reply after finding the managed PTY and confirming its
  // process is alive, so the reply is evidence of liveness. `SSH_SESSION_EXPIRED` is the token every
  // caller uses to retire the pane binding and cold-restore the agent — emitting it here put a
  // second `claude --resume` onto the transcript of a still-running one (#11006), and leaked the
  // abandoned remote PTY on every reconnect until the host refused to fork (#9034).
  it('does not claim the session expired after the retry still needs a restore', async () => {
    const { provider, request } = providerWithAttachReplies([RESTORE_REQUIRED, RESTORE_REQUIRED])

    const rejection = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-1' }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect((rejection as Error).message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect((rejection as Error).message).toContain(SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR)
    expect(isSshPtyAbsentFromRelayError(rejection)).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reattaches the live PTY when the retry opens a fresh delivery', async () => {
    const { provider, request } = providerWithAttachReplies([
      RESTORE_REQUIRED,
      { incarnationId: 'incarnation-1', replay: 'restored scrollback' }
    ])

    const result = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-1' })

    expect(result).toMatchObject({
      id: 'ssh:conn-1@@pty-1',
      isReattach: true,
      replay: 'restored scrollback'
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stops retrying rather than stacking a delivery on an unconfirmed cancellation', async () => {
    const request = vi.fn().mockResolvedValue({
      ...RESTORE_REQUIRED,
      sourceActivation: {
        status: 'pending',
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'token-1',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      }
    })
    const rollback = vi.fn().mockResolvedValue(false)
    const mux = {
      request,
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const outputState = (provider as unknown as { outputState: Record<string, unknown> })
      .outputState
    outputState.installReceivingActivation = () => ({
      commit: vi.fn(),
      rollback,
      transferToRecovery: vi.fn()
    })

    const rejection = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-1' }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect((rejection as Error).message).toContain(SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR)
    expect((rejection as Error).message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(request).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
  })
})
