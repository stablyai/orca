import { expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

it('rejects a fresh SSH PTY whose exit shares the spawn response batch', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  const exitListener = vi.fn()
  provider.onExit(exitListener)
  mux.request.mockImplementation(async (method: string) => {
    if (method === 'pty.spawn') {
      const notify = mux.onNotification.mock.calls[0]?.[0]
      notify?.('pty.exit', {
        id: 'pty-raced',
        code: 0,
        incarnationId: 'incarnation-raced'
      })
      return { id: 'pty-raced', incarnationId: 'incarnation-raced' }
    }
    return undefined
  })

  await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
    'agent_session_exited_during_start'
  )

  expect(exitListener).toHaveBeenCalledWith({
    id: 'ssh:conn-1@@pty-raced',
    code: 0,
    incarnationId: 'incarnation-raced'
  })
  mux.request.mockResolvedValue({ id: 'pty-next', incarnationId: 'incarnation-next' })
  await expect(provider.spawn({ cols: 80, rows: 24 })).resolves.toMatchObject({
    id: 'ssh:conn-1@@pty-next',
    incarnationId: 'incarnation-next'
  })
})

it('rejects an SSH reattach whose matching exit shares the attach reply batch', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  mux.request.mockImplementation(async (method: string) => {
    if (method === 'pty.attach') {
      const notify = mux.onNotification.mock.calls[0]?.[0]
      notify?.('pty.exit', {
        id: 'pty-existing',
        code: 0,
        incarnationId: 'incarnation-existing'
      })
      return { incarnationId: 'incarnation-existing' }
    }
    return undefined
  })

  await expect(
    provider.spawn({ cols: 80, rows: 24, sessionId: 'ssh:conn-1@@pty-existing' })
  ).rejects.toThrow('agent_session_exited_during_start')

  mux.request.mockResolvedValue({ incarnationId: 'incarnation-next' })
  await expect(
    provider.spawn({ cols: 80, rows: 24, sessionId: 'ssh:conn-1@@pty-existing' })
  ).resolves.toMatchObject({
    id: 'ssh:conn-1@@pty-existing',
    incarnationId: 'incarnation-next',
    isReattach: true
  })
})
