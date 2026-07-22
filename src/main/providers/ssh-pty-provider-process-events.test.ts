import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

describe('SshPtyProvider process listings and events', () => {
  let mux: MockMultiplexer
  let provider: SshPtyProvider
  const scopedPty1 = 'ssh:conn-1@@pty-1'

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshPtyProvider('conn-1', mux as never)
  })

  it('scopes process listings and bounds the relay RPC by the teardown deadline', async () => {
    const processes = [{ id: 'pty-1', cwd: '/home', title: 'zsh', worktreeId: 'repo::/home' }]
    mux.request.mockResolvedValue(processes)

    await expect(provider.listProcesses()).resolves.toEqual([
      { id: scopedPty1, cwd: '/home', title: 'zsh', worktreeId: 'repo::/home' }
    ])
    expect(mux.request).toHaveBeenLastCalledWith('pty.listProcesses', undefined, undefined)

    vi.useFakeTimers()
    try {
      mux.request.mockResolvedValue([])
      await provider.listProcesses({ deadlineMs: Date.now() + 4321 })
      expect(mux.request).toHaveBeenLastCalledWith('pty.listProcesses', undefined, {
        timeoutMs: 4321
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('scopes recovered claim owner ids with their SSH connection', async () => {
    mux.request.mockResolvedValue([
      {
        id: 'pty-1',
        incarnationId: 'incarnation-1',
        cwd: '/home',
        title: 'codex',
        agentSessionOwners: [
          {
            claim: {
              digestVersion: 1,
              keyId: 'key',
              identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              agent: 'codex'
            },
            generation: 'generation-1',
            phase: 'live',
            ptyId: 'pty-1',
            surface: {
              worktreeId: 'worktree',
              tabId: 'tab',
              leafId: '11111111-1111-4111-8111-111111111111',
              terminalHandle: 'term_claimed'
            }
          }
        ]
      }
    ])

    await expect(provider.listProcesses()).resolves.toMatchObject([
      {
        id: scopedPty1,
        incarnationId: 'incarnation-1',
        agentSessionOwners: [{ ptyId: scopedPty1 }]
      }
    ])
  })

  it('rejects recovered claimed owners without PTY incarnation proof', async () => {
    mux.request.mockResolvedValue([
      {
        id: 'pty-1',
        cwd: '/home',
        title: 'codex',
        agentSessionOwners: [
          {
            claim: {
              digestVersion: 1,
              keyId: 'key',
              identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              agent: 'codex'
            },
            generation: 'generation-1',
            phase: 'live',
            ptyId: 'pty-1',
            surface: {
              worktreeId: 'worktree',
              tabId: 'tab',
              leafId: '11111111-1111-4111-8111-111111111111',
              terminalHandle: 'term_claimed'
            }
          }
        ]
      }
    ])

    await expect(provider.listProcesses()).rejects.toThrow('agent_session_ownership_unknown')
  })

  it('forwards data, replay, and incarnation-aware exit notifications', () => {
    const dataHandler = vi.fn()
    const replayHandler = vi.fn()
    const exitHandler = vi.fn()
    provider.onData(dataHandler)
    provider.onReplay(replayHandler)
    provider.onExit(exitHandler)
    const notify = mux.onNotification.mock.calls[0][0]

    notify('pty.data', { id: 'pty-1', data: 'output' })
    notify('pty.data', { id: 'pty-1', data: '', rawLength: 9, seq: 9, transformed: true })
    notify('pty.replay', { id: 'pty-1', data: 'buffered output' })
    notify('pty.exit', { id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })

    expect(dataHandler).toHaveBeenNthCalledWith(1, { id: scopedPty1, data: 'output' })
    expect(dataHandler).toHaveBeenNthCalledWith(2, {
      id: scopedPty1,
      data: '',
      sequenceChars: 9,
      seq: 9,
      transformed: true
    })
    expect(replayHandler).toHaveBeenCalledWith({ id: scopedPty1, data: 'buffered output' })
    expect(exitHandler).toHaveBeenCalledWith({
      id: scopedPty1,
      code: 0,
      incarnationId: 'incarnation-1'
    })
  })

  it('supports listener removal, fanout, and connection namespaces', () => {
    const removed = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = provider.onData(removed)
    provider.onData(first)
    provider.onData(second)
    unsubscribe()
    mux.onNotification.mock.calls[0][0]('pty.data', { id: 'pty-1', data: 'first' })

    expect(removed).not.toHaveBeenCalled()
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()

    const otherMux = createMockMux()
    const otherProvider = new SshPtyProvider('conn-2', otherMux as never)
    const other = vi.fn()
    otherProvider.onData(other)
    otherMux.onNotification.mock.calls[0][0]('pty.data', { id: 'pty-1', data: 'second' })
    expect(other).toHaveBeenCalledWith({ id: 'ssh:conn-2@@pty-1', data: 'second' })
  })
})
