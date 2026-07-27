import { expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

function createMux(): {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
} {
  return {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

it('rejects a fresh SSH PTY whose exit shares the spawn response batch', async () => {
  const mux = createMux()
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
  const mux = createMux()
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

// Why: `pty.exit` deletes from livePtyIds during the await, so an unfenced add after
// it would resurrect a pty the relay already reported dead — the phantom-live state
// the dead-pty write guard exists to prevent (#9169).
function createExitDuringAttachMux(
  incarnations: { exitIncarnationId?: string; resultIncarnationId?: string } = {}
): ReturnType<typeof createMux> {
  const mux = createMux()
  mux.request.mockImplementation(async (method: string) => {
    if (method === 'pty.attach') {
      const notify = mux.onNotification.mock.calls[0]?.[0]
      notify?.('pty.exit', {
        id: 'pty-1',
        code: 0,
        ...(incarnations.exitIncarnationId ? { incarnationId: incarnations.exitIncarnationId } : {})
      })
      return incarnations.resultIncarnationId
        ? { incarnationId: incarnations.resultIncarnationId }
        : undefined
    }
    return undefined
  })
  return mux
}

it('fails attach() and leaves the pty not live when its exit shares the attach reply batch', async () => {
  const mux = createExitDuringAttachMux({
    exitIncarnationId: 'incarnation-gone',
    resultIncarnationId: 'incarnation-gone'
  })
  const provider = new SshPtyProvider('conn-1', mux as never)

  await expect(provider.attach('ssh:conn-1@@pty-1')).rejects.toThrow('SSH_SESSION_EXPIRED')

  expect(provider.hasPty('ssh:conn-1@@pty-1')).toBe(false)
})

it('fences attach() even when the relay reports no incarnation', async () => {
  const mux = createExitDuringAttachMux()
  const provider = new SshPtyProvider('conn-1', mux as never)

  await expect(provider.attach('ssh:conn-1@@pty-1')).rejects.toThrow('SSH_SESSION_EXPIRED')

  expect(provider.hasPty('ssh:conn-1@@pty-1')).toBe(false)
})

it('leaves a reconnect-attached pty not live when its exit shares the attach reply batch', async () => {
  const mux = createExitDuringAttachMux({
    exitIncarnationId: 'incarnation-gone',
    resultIncarnationId: 'incarnation-gone'
  })
  const provider = new SshPtyProvider('conn-1', mux as never)

  // Why: ssh-relay-session's pending-exit fence needs the incarnation to retire the
  // pane, so the exit suppresses the liveness add without failing the reattach loop.
  await expect(provider.attachForReconnect('pty-1')).resolves.toEqual({
    incarnationId: 'incarnation-gone'
  })

  expect(provider.hasPty('ssh:conn-1@@pty-1')).toBe(false)
})

it('still marks an attached pty live when a different incarnation exits mid-attach', async () => {
  const mux = createExitDuringAttachMux({
    exitIncarnationId: 'incarnation-previous',
    resultIncarnationId: 'incarnation-current'
  })
  const provider = new SshPtyProvider('conn-1', mux as never)

  await expect(provider.attachForReconnect('pty-1')).resolves.toEqual({
    incarnationId: 'incarnation-current'
  })

  expect(provider.hasPty('ssh:conn-1@@pty-1')).toBe(true)
})
