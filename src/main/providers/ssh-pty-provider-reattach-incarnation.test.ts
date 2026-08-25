import { describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import {
  TerminalSessionExitedError,
  TerminalSessionOwnerUnverifiedError
} from '../daemon/daemon-errors'

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

  it('preserves a live PTY when generic reattach cannot restore source continuity', async () => {
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

    await expect(
      provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  })

  it('rejects a replacement incarnation before accepting the attach', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({ incarnationId: 'incarnation-replacement' }),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'pty-old',
        expectedIncarnationId: 'incarnation-original'
      })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(mux.request).toHaveBeenCalledWith(
      'pty.attach',
      expect.objectContaining({ expectedIncarnationId: 'incarnation-original' }),
      expect.any(Object)
    )
  })

  it('rejects a legacy attach that cannot echo a persisted incarnation', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({ replay: 'saved output' }),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'pty-old',
        expectedIncarnationId: 'incarnation-original'
      })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  })

  it('keeps relay absence owner-unverified', async () => {
    const mux = {
      request: vi.fn().mockRejectedValue(new Error('PTY "pty-old" not found')),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(
      provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  })

  it('accepts exact relay process-exit proof as authoritative', async () => {
    const mux = {
      request: vi.fn().mockRejectedValue(new Error('terminal_session_exited: pty-old')),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'pty-old',
        expectedIncarnationId: 'incarnation-original'
      })
    ).rejects.toBeInstanceOf(TerminalSessionExitedError)
  })
})
