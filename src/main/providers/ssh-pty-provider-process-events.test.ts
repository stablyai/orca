import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import {
  MAX_SSH_PTY_PROCESS_CWD_BYTES,
  MAX_SSH_PTY_PROCESS_LIST_BYTES,
  MAX_SSH_PTY_PROCESS_LIST_ENTRIES,
  MAX_SSH_PTY_PROCESS_LIST_OWNERS,
  MAX_SSH_PTY_PROCESS_OWNERS_PER_ENTRY,
  MAX_SSH_PTY_PROCESS_TITLE_BYTES
} from './ssh-agent-session-process-list'
import { MAX_SSH_RELAY_PTY_ID_BYTES } from './ssh-pty-wire-admission'

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

  it('drops unknown process and owner fields instead of retaining remote payloads', async () => {
    const unknownPayload = 'x'.repeat(1024 * 1024)
    mux.request.mockResolvedValue([
      {
        id: 'pty-1',
        incarnationId: 'incarnation-1',
        cwd: '/home',
        title: 'codex',
        unknownPayload,
        agentSessionOwners: [
          {
            claim: {
              digestVersion: 1,
              keyId: 'key',
              identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              agent: 'codex',
              unknownPayload
            },
            generation: 'generation-1',
            phase: 'live',
            ptyId: 'pty-1',
            surface: {
              worktreeId: 'worktree',
              tabId: 'tab',
              leafId: '11111111-1111-4111-8111-111111111111',
              terminalHandle: 'term_claimed',
              unknownPayload
            },
            unknownPayload
          }
        ]
      }
    ])

    await expect(provider.listProcesses()).resolves.toEqual([
      {
        id: scopedPty1,
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
            ptyId: scopedPty1,
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

  it('rejects a non-array process list before mapping ids', async () => {
    mux.request.mockResolvedValue({ id: 'pty-1' })

    await expect(provider.listProcesses()).rejects.toThrow('invalid_ssh_pty_process_list')
  })

  it('rejects an oversized process list before mapping ids', async () => {
    const id = {
      toString: vi.fn(() => 'pty-never-map')
    }
    mux.request.mockResolvedValue(
      Array.from({ length: MAX_SSH_PTY_PROCESS_LIST_ENTRIES + 1 }, () => ({
        id,
        cwd: '/home',
        title: 'shell'
      }))
    )

    await expect(provider.listProcesses()).rejects.toThrow('invalid_ssh_pty_process_list')
    expect(id.toString).not.toHaveBeenCalled()
  })

  it('rejects oversized owner arrays before mapping owners', async () => {
    mux.request.mockResolvedValue([
      {
        id: 'pty-1',
        cwd: '/home',
        title: 'shell',
        agentSessionOwners: Array.from(
          { length: MAX_SSH_PTY_PROCESS_OWNERS_PER_ENTRY + 1 },
          () => ({})
        )
      }
    ])

    await expect(provider.listProcesses()).rejects.toThrow('invalid_ssh_pty_process_list')
  })

  it('rejects owner amplification spread across otherwise valid sessions', async () => {
    const owner = {
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
    const ownersPerSession = MAX_SSH_PTY_PROCESS_OWNERS_PER_ENTRY
    const sessionCount = Math.floor(MAX_SSH_PTY_PROCESS_LIST_OWNERS / ownersPerSession) + 1
    mux.request.mockResolvedValue(
      Array.from({ length: sessionCount }, (_, sessionIndex) => {
        const id = `pty-${sessionIndex}`
        return {
          id,
          incarnationId: 'incarnation-1',
          cwd: '/home',
          title: 'shell',
          agentSessionOwners: Array.from({ length: ownersPerSession }, (_, ownerIndex) => ({
            ...owner,
            generation: `generation-${sessionIndex}-${ownerIndex}`,
            ptyId: id
          }))
        }
      })
    )

    await expect(provider.listProcesses()).rejects.toThrow('invalid_ssh_pty_process_list')
  })

  it.each([
    {
      field: 'id',
      value: 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES + 1)
    },
    {
      field: 'cwd',
      value: 'x'.repeat(MAX_SSH_PTY_PROCESS_CWD_BYTES + 1)
    },
    {
      field: 'title',
      value: 'x'.repeat(MAX_SSH_PTY_PROCESS_TITLE_BYTES + 1)
    }
  ])('rejects an oversized $field before mapping', async ({ field, value }) => {
    mux.request.mockResolvedValue([{ id: 'pty-1', cwd: '/home', title: 'shell', [field]: value }])

    await expect(provider.listProcesses()).rejects.toThrow('invalid_ssh_pty_process_list')
  })

  it('rejects process-list strings above the aggregate byte budget', async () => {
    const cwd = 'x'.repeat(MAX_SSH_PTY_PROCESS_CWD_BYTES)
    const count = Math.floor(MAX_SSH_PTY_PROCESS_LIST_BYTES / Buffer.byteLength(cwd)) + 1
    mux.request.mockResolvedValue(
      Array.from({ length: count }, (_, index) => ({
        id: `pty-${index}`,
        cwd,
        title: 'shell'
      }))
    )

    await expect(provider.listProcesses()).rejects.toThrow('invalid_ssh_pty_process_list')
  })

  it('rejects an oversized spawn id before retention', async () => {
    const oversized = 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES + 1)
    mux.request.mockResolvedValue({ id: oversized })

    await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow('invalid_ssh_pty_id')
    expect(provider.hasPty(`ssh:conn-1@@${oversized}`)).toBe(false)
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
    expect(provider.hasPty(scopedPty1)).toBe(true)
    notify('pty.exit', { id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })
    expect(provider.hasPty(scopedPty1)).toBe(false)

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

  it('drops malformed notification ids before routing or retention', () => {
    const dataHandler = vi.fn()
    const replayHandler = vi.fn()
    const exitHandler = vi.fn()
    provider.onData(dataHandler)
    provider.onReplay(replayHandler)
    provider.onExit(exitHandler)
    const notify = mux.onNotification.mock.calls[0][0]
    const oversized = 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES + 1)

    notify('pty.data', { id: 42, data: 'output', deliveryToken: 'token' })
    notify('pty.replay', { id: oversized, data: 'replay' })
    notify('pty.exit', { id: oversized, code: 0 })

    expect(dataHandler).not.toHaveBeenCalled()
    expect(replayHandler).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
    expect(provider.hasPty(`ssh:conn-1@@${oversized}`)).toBe(false)
    expect(mux.notify).not.toHaveBeenCalled()
  })

  it('drops malformed notification payloads before liveness or exit-race mutation', () => {
    const dataHandler = vi.fn()
    const replayHandler = vi.fn()
    const exitHandler = vi.fn()
    provider.onData(dataHandler)
    provider.onReplay(replayHandler)
    provider.onExit(exitHandler)
    const notify = mux.onNotification.mock.calls[0][0]

    notify('pty.data', { id: 'pty-bad-data', data: 42, deliveryToken: 'token' })
    notify('pty.replay', { id: 'pty-bad-replay', data: { nested: 'output' } })
    notify('pty.exit', { id: 'pty-bad-code', code: '0', incarnationId: 'incarnation-1' })
    notify('pty.exit', { id: 'pty-bad-incarnation', code: 0, incarnationId: 'x'.repeat(129) })

    expect(dataHandler).not.toHaveBeenCalled()
    expect(replayHandler).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
    expect(provider.hasPty('ssh:conn-1@@pty-bad-data')).toBe(false)
    expect(provider.hasPty('ssh:conn-1@@pty-bad-replay')).toBe(false)
    expect(provider.hasPty('ssh:conn-1@@pty-bad-code')).toBe(false)
    expect(provider.hasPty('ssh:conn-1@@pty-bad-incarnation')).toBe(false)
    expect(mux.notify).not.toHaveBeenCalled()
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
