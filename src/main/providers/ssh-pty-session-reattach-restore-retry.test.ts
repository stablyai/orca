import { describe, expect, it, vi } from 'vitest'
import { reattachSshPtySession } from './ssh-pty-session-reattach'
import { SshPtyProvider } from './ssh-pty-provider'
import { SSH_SESSION_EXPIRED_ERROR } from './ssh-pty-errors'

const restoreRequired = {
  incarnationId: 'incarnation-live',
  sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
}

describe('SSH PTY session reattach restore retry', () => {
  it('re-attaches after restoreRequired and returns the fresh replay', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(restoreRequired)
      .mockResolvedValueOnce({ incarnationId: 'incarnation-live', replay: 'scrollback' })

    const result = await reattachSshPtySession({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' }
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      id: 'ssh:conn-1@@pty-live',
      isReattach: true,
      replay: 'scrollback',
      incarnationId: 'incarnation-live'
    })
    expect(result.sourceRecovery).toBeUndefined()
  })

  it('rolls back a stale activation lease before retrying', async () => {
    const activation = {
      status: 'pending',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-live',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...restoreRequired, sourceActivation: activation })
      .mockResolvedValueOnce({ incarnationId: 'incarnation-live', replay: 'scrollback' })
    const rollback = vi.fn().mockResolvedValue(true)
    const installSourceActivation = vi.fn().mockReturnValue({ commit: vi.fn(), rollback })

    const result = await reattachSshPtySession({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' },
      installSourceActivation
    })

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(result.replay).toBe('scrollback')
  })

  it('stops retrying when the stale lease cancellation is unconfirmed', async () => {
    const activation = {
      status: 'pending',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-live',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    }
    const request = vi.fn().mockResolvedValue({ ...restoreRequired, sourceActivation: activation })
    const rollback = vi.fn().mockResolvedValue(false)
    const installSourceActivation = vi.fn().mockReturnValue({ commit: vi.fn(), rollback })

    const result = await reattachSshPtySession({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' },
      installSourceActivation
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(result.sourceRecovery).toMatchObject({ status: 'restoreRequired' })
  })

  it('fails closed only after bounded restoreRequired attach attempts', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue(restoreRequired),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
      `${SSH_SESSION_EXPIRED_ERROR}: pty-old`
    )
    expect(mux.request).toHaveBeenCalledTimes(3)
  })
})
