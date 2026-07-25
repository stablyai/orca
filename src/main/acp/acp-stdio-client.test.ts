import { describe, expect, it, vi } from 'vitest'
import {
  ACP_CLIENT_PROTOCOL_VERSION,
  createAcpStdioClient,
  type AcpChildLike
} from './acp-stdio-client'

/** A scriptable stand-in for the agent process: captures what the client wrote
 *  and lets a test push stdout frames / lifecycle events back. */
function createFakeAgent() {
  const written: string[] = []
  const listeners: { exit?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } = {}
  let onStdout: ((chunk: string) => void) | undefined
  let onStderr: ((chunk: string) => void) | undefined
  const killed: NodeJS.Signals[] = []

  const child: AcpChildLike = {
    pid: 4242,
    stdin: {
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
      end: () => undefined
    },
    stdout: {
      on: (_event, listener) => {
        onStdout = listener as (chunk: string) => void
        return undefined
      }
    },
    stderr: {
      on: (_event, listener) => {
        onStderr = listener as (chunk: string) => void
        return undefined
      }
    },
    on: (event, listener) => {
      listeners[event] = listener
      return undefined
    },
    kill: (signal) => {
      killed.push((signal ?? 'SIGTERM') as NodeJS.Signals)
      return true
    }
  }

  return {
    child,
    written,
    killed,
    /** Every JSON-RPC message the client has sent. */
    sent: () => written.map((line) => JSON.parse(line.trim())),
    lastSent: () => JSON.parse(written.at(-1)!.trim()),
    emitStdout: (text: string) => onStdout?.(text),
    emitStderr: (text: string) => onStderr?.(text),
    emitExit: (code: number | null, signal: string | null) => listeners.exit?.(code, signal),
    emitError: (error: Error) => listeners.error?.(error),
    /** Answer the client's most recent request with a result. */
    reply: (result: unknown) => {
      const { id } = JSON.parse(written.at(-1)!.trim())
      onStdout?.(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
    }
  }
}

function createClient(overrides: Partial<Parameters<typeof createAcpStdioClient>[0]> = {}) {
  const agent = createFakeAgent()
  const onSessionUpdate = vi.fn()
  const onLog = vi.fn()
  const client = createAcpStdioClient({
    command: 'hermes',
    args: ['acp'],
    cwd: '/repo',
    onSessionUpdate,
    onLog,
    spawn: () => agent.child,
    ...overrides
  })
  return { agent, client, onSessionUpdate, onLog }
}

describe('createAcpStdioClient', () => {
  it('initializes with the client protocol version and no fs capability', async () => {
    const { agent, client } = createClient()
    const pending = client.initialize()

    const sent = agent.lastSent()
    expect(sent.method).toBe('initialize')
    expect(sent.params.protocolVersion).toBe(ACP_CLIENT_PROTOCOL_VERSION)
    // Orca renders the conversation; it must not lend the agent its filesystem.
    expect(sent.params.clientCapabilities.fs).toEqual({
      readTextFile: false,
      writeTextFile: false
    })

    agent.reply({ protocolVersion: 1, agentInfo: { name: 'hermes-agent', version: '0.19.0' } })
    await expect(pending).resolves.toMatchObject({ agentInfo: { name: 'hermes-agent' } })
  })

  it('logs a protocol-version mismatch rather than guessing compatibility', async () => {
    const { agent, client, onLog } = createClient()
    const pending = client.initialize()
    agent.reply({ protocolVersion: 99 })
    await pending
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('protocol v99'))
  })

  it('correlates concurrent requests by id', async () => {
    const { agent, client } = createClient()
    const first = client.request('a')
    const second = client.request('b')
    const [firstSent, secondSent] = agent.sent()

    // Reply out of order to prove correlation is by id, not arrival order.
    agent.emitStdout(
      `${JSON.stringify({ jsonrpc: '2.0', id: secondSent.id, result: 'second' })}\n`
    )
    agent.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: firstSent.id, result: 'first' })}\n`)

    await expect(second).resolves.toBe('second')
    await expect(first).resolves.toBe('first')
  })

  it('rejects a request when the agent returns a JSON-RPC error', async () => {
    const { agent, client } = createClient()
    const pending = client.request('session/prompt')
    const { id } = agent.lastSent()
    agent.emitStdout(
      `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'bad params' } })}\n`
    )
    await expect(pending).rejects.toThrow('bad params')
  })

  it('routes session/update notifications to the handler with the session id', () => {
    const { agent, onSessionUpdate } = createClient()
    agent.emitStdout(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-9',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
        }
      })}\n`
    )
    expect(onSessionUpdate).toHaveBeenCalledWith(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      'sess-9'
    )
  })

  it('returns session/new sessionId, and throws when the agent omits it', async () => {
    const { agent, client } = createClient()
    const ok = client.newSession({ cwd: '/repo' })
    agent.reply({ sessionId: 'sess-1' })
    await expect(ok).resolves.toBe('sess-1')

    const bad = client.newSession()
    agent.reply({})
    await expect(bad).rejects.toThrow('no sessionId')
  })

  it('answers a permission request with the operator choice', async () => {
    const onPermissionRequest = vi.fn().mockResolvedValue('opt-allow')
    const { agent } = createClient({ onPermissionRequest })
    agent.emitStdout(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'session/request_permission',
        params: { toolCall: { title: 'bash' }, options: [{ optionId: 'opt-allow' }] }
      })}\n`
    )
    await vi.waitFor(() => expect(agent.lastSent().id).toBe(77))
    expect(agent.lastSent().result).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow' }
    })
  })

  it('cancels a permission request when no handler is installed', async () => {
    const { agent, onLog } = createClient()
    agent.emitStdout(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'x' }] }
      })}\n`
    )
    await vi.waitFor(() => expect(agent.lastSent().id).toBe(5))
    // No handler must never become an implicit allow.
    expect(agent.lastSent().result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('no permission handler'))
  })

  it('cancels when the permission handler throws', async () => {
    const onPermissionRequest = vi.fn().mockRejectedValue(new Error('ui closed'))
    const { agent } = createClient({ onPermissionRequest })
    agent.emitStdout(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'x' }] }
      })}\n`
    )
    await vi.waitFor(() => expect(agent.lastSent().id).toBe(6))
    expect(agent.lastSent().result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('answers an unsupported agent request so the turn cannot hang', () => {
    const { agent } = createClient()
    agent.emitStdout(
      `${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'fs/read_text_file', params: {} })}\n`
    )
    expect(agent.lastSent()).toMatchObject({ id: 12, error: { code: -32601 } })
  })

  it('ignores an unsupported notification (no id, nothing to answer)', () => {
    const { agent } = createClient()
    const before = agent.written.length
    agent.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', method: 'something/else' })}\n`)
    expect(agent.written.length).toBe(before)
  })

  it('sends cancel as a notification with no id', () => {
    const { agent, client } = createClient()
    client.cancel('sess-1')
    const sent = agent.lastSent()
    expect(sent.method).toBe('session/cancel')
    expect(sent.id).toBeUndefined()
  })

  it('forwards agent stderr line by line as logs', () => {
    const { agent, onLog } = createClient()
    agent.emitStderr('starting\n\nregistered 51 tools\n')
    expect(onLog).toHaveBeenCalledWith('starting')
    expect(onLog).toHaveBeenCalledWith('registered 51 tools')
  })

  it('rejects in-flight requests when the agent exits, and reports the exit', async () => {
    const onExit = vi.fn()
    const { agent, client } = createClient({ onExit })
    const pending = client.request('session/prompt')
    agent.emitExit(1, null)
    await expect(pending).rejects.toThrow('ACP agent exited')
    expect(onExit).toHaveBeenCalledWith(1, null)
    expect(client.disposed).toBe(true)
  })

  it('rejects in-flight requests when the process fails to start', async () => {
    const { agent, client } = createClient()
    const pending = client.request('initialize')
    agent.emitError(new Error('ENOENT'))
    await expect(pending).rejects.toThrow('failed to start')
  })

  it('rejects new requests after dispose and escalates to a tree kill', async () => {
    vi.useFakeTimers()
    try {
      const { agent, client } = createClient()
      client.dispose()
      expect(client.disposed).toBe(true)
      await expect(client.request('anything')).rejects.toThrow('disposed')

      // Closing stdin is the clean shutdown; a stuck agent must not survive it.
      expect(agent.killed).toEqual([])
      vi.advanceTimersByTime(2_000)
      expect(agent.killed).toEqual(['SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('is idempotent on repeated dispose', () => {
    const { client } = createClient()
    client.dispose()
    expect(() => client.dispose()).not.toThrow()
  })

  it('survives a malformed stdout frame and keeps decoding', () => {
    const { agent, onSessionUpdate, onLog } = createClient()
    agent.emitStdout('this is not json\n')
    agent.emitStdout(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } }
      })}\n`
    )
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('malformed frame'))
    expect(onSessionUpdate).toHaveBeenCalledOnce()
  })

  it('times out a request that is never answered', async () => {
    vi.useFakeTimers()
    try {
      const { client } = createClient()
      const pending = client.request('session/prompt')
      const assertion = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
