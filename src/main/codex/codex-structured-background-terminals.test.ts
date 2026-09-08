import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import {
  createCodexBackgroundTerminals,
  refreshCodexBackgroundTerminals,
  stopCodexBackgroundTerminals
} from './codex-structured-background-terminals'
import type { CodexSession } from './codex-structured-session-state'

function makeSession(request: ReturnType<typeof vi.fn>): CodexSession {
  return { connection: { request }, threadId: 'thread-1' } as unknown as CodexSession
}

const ONE_TERMINAL = {
  data: [{ itemId: 'item-1', processId: 'proc-1', command: 'sleep 180', osPid: 14040 }]
}

describe('codex background terminals', () => {
  describe('reading the live list', () => {
    it('publishes a running terminal as a stoppable monitored task', async () => {
      const request = vi.fn().mockResolvedValue(ONE_TERMINAL)
      const terminals = createCodexBackgroundTerminals()

      const changed = await refreshCodexBackgroundTerminals(terminals, makeSession(request), 5_000)

      expect(changed).toBe(true)
      expect(request).toHaveBeenCalledWith(
        'thread/backgroundTerminals/list',
        { threadId: 'thread-1' },
        { timeoutMs: 5_000 }
      )
      expect(terminals.state).toEqual({
        state: 'monitoring',
        tasks: [{ id: 'proc-1', kind: 'command', description: 'sleep 180' }],
        supportsTaskStop: true
      })
    })

    it('reports an empty list as nothing to monitor', async () => {
      const terminals = createCodexBackgroundTerminals()

      await refreshCodexBackgroundTerminals(
        terminals,
        makeSession(vi.fn().mockResolvedValue({ data: [] }))
      )

      expect(terminals.supported).toBe(true)
      expect(terminals.state).toBeNull()
    })

    it('does not wake subscribers when the list is unchanged', async () => {
      const request = vi.fn().mockResolvedValue(ONE_TERMINAL)
      const terminals = createCodexBackgroundTerminals()
      const session = makeSession(request)

      expect(await refreshCodexBackgroundTerminals(terminals, session)).toBe(true)
      expect(await refreshCodexBackgroundTerminals(terminals, session)).toBe(false)
    })

    it('drops a row without a process id rather than offering an unstoppable task', async () => {
      const terminals = createCodexBackgroundTerminals()
      const response = { data: [{ command: 'sleep 180' }, ONE_TERMINAL.data[0]] }

      await refreshCodexBackgroundTerminals(
        terminals,
        makeSession(vi.fn().mockResolvedValue(response))
      )

      expect(terminals.state?.tasks).toEqual([
        { id: 'proc-1', kind: 'command', description: 'sleep 180' }
      ])
    })
  })

  describe('capability probe', () => {
    it('latches off and stays quiet when the host refuses the operation', async () => {
      // Method-not-found reaches callers as CodexAppServerUnsupportedError:
      // the dispatcher converts -32601 before anyone sees it, so a
      // RequestError carrying -32601 is a value production cannot produce.
      const request = vi
        .fn()
        .mockRejectedValue(
          new CodexAppServerUnsupportedError(
            'codex app-server does not support thread/backgroundTerminals/list: method not found'
          )
        )
      const terminals = createCodexBackgroundTerminals()
      const session = makeSession(request)

      await refreshCodexBackgroundTerminals(terminals, session)

      expect(terminals.supported).toBe(false)
      expect(terminals.state).toBeNull()

      // Latched: a later refresh must not ask again, so an older host never
      // pays for a probe per turn.
      await refreshCodexBackgroundTerminals(terminals, session)
      expect(request).toHaveBeenCalledOnce()
    })

    it('refuses to stop once the capability is off, without calling the host', async () => {
      const request = vi.fn()
      const terminals = createCodexBackgroundTerminals()
      terminals.supported = false

      const result = await stopCodexBackgroundTerminals(terminals, makeSession(request))

      expect(result).toEqual({ cancelled: false })
      expect(request).not.toHaveBeenCalled()
    })

    it('keeps the capability after a transient failure so a blip cannot hide the control', async () => {
      const request = vi.fn().mockRejectedValue(new Error('connection closed'))
      const terminals = createCodexBackgroundTerminals()
      terminals.supported = true

      await refreshCodexBackgroundTerminals(terminals, makeSession(request))

      expect(terminals.supported).toBe(true)
    })
  })

  describe('stopping', () => {
    it('cleans every terminal when no task is named', async () => {
      const request = vi.fn().mockResolvedValue({})
      const terminals = createCodexBackgroundTerminals()

      const result = await stopCodexBackgroundTerminals(terminals, makeSession(request), 5_000)

      expect(result).toEqual({ cancelled: true })
      expect(request).toHaveBeenCalledWith(
        'thread/backgroundTerminals/clean',
        { threadId: 'thread-1' },
        { timeoutMs: 5_000 }
      )
    })

    it('terminates one terminal by its process id', async () => {
      const request = vi.fn().mockResolvedValue({ terminated: true })
      const terminals = createCodexBackgroundTerminals()

      const result = await stopCodexBackgroundTerminals(
        terminals,
        makeSession(request),
        5_000,
        'proc-1'
      )

      expect(result).toEqual({ cancelled: true })
      expect(request).toHaveBeenCalledWith(
        'thread/backgroundTerminals/terminate',
        { threadId: 'thread-1', processId: 'proc-1' },
        { timeoutMs: 5_000 }
      )
    })

    it('reports an unconfirmed stop and hides the control when the host refuses', async () => {
      const request = vi
        .fn()
        .mockRejectedValue(
          new CodexAppServerUnsupportedError(
            'codex app-server does not support thread/backgroundTerminals/clean: method not found'
          )
        )
      const terminals = createCodexBackgroundTerminals()
      terminals.state = { state: 'monitoring', tasks: [], supportsTaskStop: true }

      const result = await stopCodexBackgroundTerminals(terminals, makeSession(request))

      expect(result).toEqual({ cancelled: false })
      expect(terminals.supported).toBe(false)
      expect(terminals.state).toBeNull()
    })
  })
})

// Errors the dispatcher really produces for a host that HAS the methods. None
// of these may latch the capability off: one bad turn would otherwise hide the
// row and the Stop button for the rest of the session.
describe('refusals that must not latch the capability off', () => {
  const transient = (code: number, message: string): CodexAppServerRequestError =>
    new CodexAppServerRequestError(
      'thread/backgroundTerminals/list',
      code,
      `codex app-server thread/backgroundTerminals/list failed: ${message}`
    )

  it.each([
    ['a thread lost to a resume race', -32600, 'invalid_request: thread not found'],
    ['an internal server error', -32603, 'internal_error'],
    ['the experimental-API gate', -32600, 'invalid_request: experimental API not enabled']
  ])('keeps asking after %s', async (_case, code, message) => {
    const request = vi.fn().mockRejectedValue(transient(code as number, message as string))
    const terminals = createCodexBackgroundTerminals()
    const session = makeSession(request)

    await refreshCodexBackgroundTerminals(terminals, session)
    await refreshCodexBackgroundTerminals(terminals, session)

    // Not latched, so the next turn tries again...
    expect(terminals.supported).not.toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
    // ...and until one succeeds the client is shown nothing, which is the safe
    // direction to fail in.
    expect(terminals.state).toBeNull()
  })

  it('does not hide a live row because one stop attempt failed', async () => {
    const terminals = createCodexBackgroundTerminals()
    terminals.supported = true
    terminals.state = { state: 'monitoring', tasks: [], supportsTaskStop: true }
    const request = vi
      .fn()
      .mockRejectedValue(
        new CodexAppServerRequestError('thread/backgroundTerminals/clean', -32603, 'internal_error')
      )

    const result = await stopCodexBackgroundTerminals(terminals, makeSession(request))

    expect(result).toEqual({ cancelled: false })
    expect(terminals.supported).toBe(true)
    expect(terminals.state).not.toBeNull()
  })
})
