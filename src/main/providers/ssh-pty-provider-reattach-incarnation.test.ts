import { describe, expect, it, vi } from 'vitest'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  SSH_SOURCE_RESTORE_REQUIRED_ERROR
} from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH PTY provider session reattach incarnation', () => {
  it.each([
    ['an old-relay response without an incarnation', {}],
    ['a response for a different incarnation', { incarnationId: 'incarnation-other' }]
  ])('rejects %s', async (_label, response) => {
    const mux = {
      request: vi.fn().mockResolvedValue(response),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(
      provider.attachForReconnect('ssh:conn-1@@pty-old', undefined, 'incarnation-expected')
    ).rejects.toThrow(SSH_PTY_IDENTITY_MISMATCH_ERROR)
  })

  it('remembers the authoritative incarnation before a legacy exit arrives', async () => {
    let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
    const mux = {
      request: vi.fn().mockResolvedValue({ incarnationId: 'incarnation-reattached' }),
      notify: vi.fn(),
      onNotification: vi.fn(
        (callback: (method: string, params: Record<string, unknown>) => void) => {
          notify = callback
          return vi.fn()
        }
      )
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const onExit = vi.fn()
    provider.onExit(onExit)

    await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
    notify?.('pty.exit', { id: 'pty-old', code: 0 })

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ssh:conn-1@@pty-old',
        ptyIncarnation: 'incarnation-reattached'
      })
    )
  })

  it('fails closed when generic reattach requires source restoration', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({
        incarnationId: 'incarnation-reattached',
        sourceRecovery: {
          status: 'restoreRequired',
          reason: 'checkpointUnavailable'
        }
      }),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    // Fails closed, but NOT as expiry: the shell is still running, and callers
    // respawn on expiry — which duplicate-resumed the live agent session.
    const spawn = provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
    await expect(spawn).rejects.toThrow(`${SSH_SOURCE_RESTORE_REQUIRED_ERROR}: pty-old`)
    await expect(spawn).rejects.not.toThrow(SSH_SESSION_EXPIRED_ERROR)
  })
})
