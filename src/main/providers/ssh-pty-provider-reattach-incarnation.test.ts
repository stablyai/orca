import { describe, expect, it, vi } from 'vitest'
import { SSH_SESSION_EXPIRED_ERROR } from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'
import { parseSshPtyAttachResult } from './ssh-pty-session-reattach'

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

    await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
      `${SSH_SESSION_EXPIRED_ERROR}: pty-old`
    )
  })

  it('threads attach-boundary modes into the reattach spawn result', async () => {
    const modes = {
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag',
      sgrMouseMode: true,
      applicationCursor: false,
      alternateScreen: true
    }
    const mux = {
      request: vi.fn().mockResolvedValue({ replay: 'tail', modes }),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    const result = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })

    expect(result.isReattach).toBe(true)
    expect(result.modes).toEqual(modes)
  })
})

describe('parseSshPtyAttachResult modes', () => {
  it('accepts a valid modes payload', () => {
    const modes = {
      bracketedPaste: false,
      mouseTracking: true,
      mouseTrackingMode: 'any',
      applicationCursor: true,
      alternateScreen: false
    }
    expect(parseSshPtyAttachResult({ replay: 'tail', modes })).toEqual({
      replay: 'tail',
      modes
    })
  })

  it('omits modes when the payload has none', () => {
    expect(parseSshPtyAttachResult({ replay: 'tail' })).toEqual({ replay: 'tail' })
  })

  it('drops malformed modes without failing the attach', () => {
    expect(parseSshPtyAttachResult({ replay: 'tail', modes: { bracketedPaste: 'yes' } })).toEqual({
      replay: 'tail'
    })
    expect(parseSshPtyAttachResult({ replay: 'tail', modes: 'alt' })).toEqual({ replay: 'tail' })
    expect(parseSshPtyAttachResult({ replay: 'tail', modes: [] })).toEqual({ replay: 'tail' })
  })
})
