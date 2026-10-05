import { describe, expect, it, vi } from 'vitest'
import { SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR } from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH PTY provider session reattach incarnation', () => {
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

  it('fails closed without claiming expiry when reattach requires source restoration', async () => {
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

    // The relay proved the PTY alive before answering restoreRequired, so the rejection must not
    // carry the token that makes callers retire the binding and cold-restore the agent.
    await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
      new RegExp(`^${SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR}: pty-old`)
    )
  })

  it('carries the relay-held launch agent so the reattach can be re-admitted (R1-SSH)', async () => {
    const reattach = async (reply: Record<string, unknown>) => {
      const mux = {
        request: vi.fn().mockResolvedValue(reply),
        notify: vi.fn(),
        onNotification: vi.fn().mockReturnValue(vi.fn())
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only calls request/notify/onNotification, which this stub implements.
      return new SshPtyProvider('conn-1', mux as never).spawn({
        cols: 80,
        rows: 24,
        sessionId: 'pty-old'
      })
    }

    const agent = await reattach({ incarnationId: 'incarnation-reattached', launchAgent: 'claude' })
    expect(agent).toMatchObject({ isReattach: true, launchAgent: 'claude' })
    // An older relay omits the field and an unknown value is not evidence: both stay unadmitted.
    const legacy = await reattach({ incarnationId: 'incarnation-reattached' })
    expect(legacy).not.toHaveProperty('launchAgent')
    const unknown = await reattach({ incarnationId: 'incarnation-reattached', launchAgent: 'nope' })
    expect(unknown).not.toHaveProperty('launchAgent')
  })
})
