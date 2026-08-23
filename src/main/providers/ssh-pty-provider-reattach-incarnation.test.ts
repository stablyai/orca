import { describe, expect, it, vi } from 'vitest'
import { SSH_PTY_RESTORE_REQUIRED_ERROR } from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH PTY provider session reattach incarnation', () => {
  it('replaces provisional exit identity with the authoritative attach incarnation', async () => {
    let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
    let resolveAttach: ((value: { incarnationId: string }) => void) | undefined
    const mux = {
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveAttach = resolve
          })
      ),
      notify: vi.fn(),
      onNotification: vi.fn(
        (callback: (method: string, params: Record<string, unknown>) => void) => {
          notify = callback
          return vi.fn()
        }
      )
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const onData = vi.fn()
    provider.onData(onData)
    const attach = provider.attachForReconnect('ssh:conn-1@@pty-old')
    await vi.waitFor(() => expect(resolveAttach).toBeTypeOf('function'))

    notify?.('pty.exit', { id: 'pty-old', code: 0 })
    resolveAttach?.({ incarnationId: 'incarnation-reattached' })
    await attach
    notify?.('pty.data', { id: 'pty-old', data: 'current-output' })

    expect(onData).toHaveBeenCalledWith({
      id: 'ssh:conn-1@@pty-old',
      data: 'current-output',
      providerGeneration: expect.any(Number),
      ptyIncarnation: 'incarnation-reattached'
    })
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

  it('does not report expiry when generic reattach requires source restoration', async () => {
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

    await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
      `${SSH_PTY_RESTORE_REQUIRED_ERROR}: pty-old`
    )
  })
})
