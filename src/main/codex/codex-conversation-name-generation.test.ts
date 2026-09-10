import { describe, expect, it, vi } from 'vitest'
import {
  createCodexNamingTurnCollector,
  generateAndSetCodexConversationName,
  readCodexGeneratedTitle
} from './codex-conversation-name-generation'

let capabilityKeys = 0
let shared = 0

function unsupported(): Error {
  const error = new Error('thread/name/set is not supported')
  error.name = 'CodexAppServerUnsupportedError'
  return error
}

function generation(
  options: {
    read?: unknown
    opened?: unknown
    config?: unknown
    answer?: string | null
    /** Host that has no `thread/name/set`, refusing the pre-turn probe. */
    probeUnsupported?: boolean
    /** Probe passes but the user's own thread refuses the name. */
    userNameSetUnsupported?: boolean
    capabilityKey?: string
  } = {}
) {
  // The capability cache is a module singleton; a fresh key per fixture keeps
  // one test's remembered host out of the next one.
  const capabilityKey = options.capabilityKey ?? `host-${(capabilityKeys += 1)}`
  const collector = createCodexNamingTurnCollector(1000)
  const connection = {
    request: vi.fn(async (method: string) => {
      if (method === 'config/read') {
        return options.config ?? { config: { mcp_servers: { files: { command: 'server' } } } }
      }
      if (method === 'thread/start') {
        return options.opened ?? { thread: { id: 'naming', ephemeral: true } }
      }
      if (method === 'thread/name/set' && options.probeUnsupported) {
        throw unsupported()
      }
      if (method === 'turn/start') {
        if (options.answer !== null) {
          collector.handle('item/completed', {
            item: { type: 'agentMessage', text: options.answer ?? '{"title":"Fix lease probe"}' }
          })
        }
        collector.handle('turn/completed', {})
      }
      return {}
    })
  }
  const userConnection = {
    request: vi.fn(async (method: string) => {
      if (method === 'thread/name/set' && options.userNameSetUnsupported) {
        throw unsupported()
      }
      return options.read ?? { thread: { id: 'user', name: null } }
    })
  }
  const run = () =>
    generateAndSetCodexConversationName({
      connection,
      userConnection,
      collector,
      cwd: '/folder',
      threadId: 'user',
      prompt: 'fix lease probe',
      model: 'selected-model',
      capabilityKey,
      isCancelled: () => false
    }).finally(() => collector.dispose())
  return { run, connection, userConnection }
}

describe('Codex conversation naming generation', () => {
  it('generates independently and publishes only the final name on the user connection', async () => {
    const { run, connection, userConnection } = generation()
    await expect(run()).resolves.toEqual({ name: 'Fix lease probe', settled: true })
    expect(connection.request.mock.calls.map(([method]) => method)).toEqual([
      'config/read',
      'thread/start',
      // Proves the host stores a thread name before any turn is billed.
      'thread/name/set',
      'turn/start'
    ])
    expect(userConnection.request.mock.calls).toEqual([
      ['thread/read', { threadId: 'user' }, { timeoutMs: undefined }],
      ['thread/name/set', { threadId: 'user', name: 'Fix lease probe' }, { timeoutMs: undefined }]
    ])
  })

  it('disables effective MCP servers and tools and preserves the selected model', async () => {
    const { run, connection } = generation()
    await run()
    expect(connection.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        model: 'selected-model',
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        dynamicTools: [],
        environments: [],
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        config: expect.objectContaining({
          mcp_servers: { files: { enabled: false } },
          'features.shell_tool': false,
          'features.unified_exec': false,
          'features.multi_agent': false,
          'features.plugins': false,
          web_search: 'disabled'
        })
      }),
      expect.anything()
    )
  })

  it.each([
    { thread: { id: 'user', name: 'My own name' } },
    { threadId: 'user' },
    { thread: { id: 'another', name: null } },
    'unreadable'
  ])('does not overwrite a named or unreadable thread: %j', async (read) => {
    const { run, userConnection } = generation({ read })
    await expect(run()).resolves.toEqual({ name: null, settled: true })
    expect(userConnection.request).toHaveBeenCalledTimes(1)
  })

  it('deletes and refuses a naming thread when the host ignored ephemeral', async () => {
    const { run, connection, userConnection } = generation({ opened: { thread: { id: 'naming' } } })
    await expect(run()).resolves.toEqual({ name: null, settled: false })
    expect(connection.request).toHaveBeenCalledWith(
      'thread/delete',
      { threadId: 'naming' },
      expect.anything()
    )
    expect(userConnection.request).not.toHaveBeenCalled()
  })

  it('never runs or deletes the user thread when start returns its identity', async () => {
    const { run, connection } = generation({ opened: { thread: { id: 'user' } } })
    await expect(run()).resolves.toEqual({ name: null, settled: false })
    expect(connection.request.mock.calls.map(([method]) => method)).toEqual([
      'config/read',
      'thread/start'
    ])
  })

  it('fails closed when effective configuration cannot be read', async () => {
    const { run, connection } = generation({ config: {} })
    await expect(run()).rejects.toThrow('readable effective configuration')
    expect(connection.request).toHaveBeenCalledTimes(1)
  })

  // Every case here has already paid for a turn, so all of them must settle:
  // an unsettled outcome re-pays a fresh turn on the next acquisition.
  it.each([null, 'prose', '{"title":""}'])(
    'settles declines and unusable responses so the billed turn is not repeated: %s',
    async (answer) => {
      await expect(generation({ answer }).run()).resolves.toEqual({ name: null, settled: true })
    }
  )

  it('bounds and flattens provider names', async () => {
    const { run } = generation({
      answer: JSON.stringify({ title: `Fix\nprobe ${'x'.repeat(400)}` })
    })
    const { name } = await run()
    expect(name).not.toContain('\n')
    expect(name!.length).toBeLessThanOrEqual(200)
  })

  it('never pays for a turn on a host that cannot store a thread name', async () => {
    const { run, connection, userConnection } = generation({ probeUnsupported: true })

    // Unsettled on purpose: nothing was billed, so a later codex upgrade can
    // still name this conversation.
    await expect(run()).resolves.toEqual({ name: null, settled: false })
    expect(connection.request.mock.calls.map(([method]) => method)).toEqual([
      'config/read',
      'thread/start',
      'thread/name/set'
    ])
    expect(userConnection.request).not.toHaveBeenCalled()
  })

  it('remembers the missing capability so a second session skips the probe and the turn', async () => {
    const capabilityKey = `shared-${(shared += 1)}`
    await generation({ probeUnsupported: true, capabilityKey }).run()

    const { run, connection } = generation({ capabilityKey })

    await expect(run()).resolves.toEqual({ name: null, settled: false })
    expect(connection.request.mock.calls.map(([method]) => method)).toEqual([
      'config/read',
      'thread/start'
    ])
  })

  it('settles and records the absence when the user thread refuses the name', async () => {
    // The turn is already paid for here, so leaving it unsettled would re-pay a
    // fresh turn on every acquisition and could never succeed.
    const capabilityKey = `shared-${(shared += 1)}`
    await expect(
      generation({ userNameSetUnsupported: true, capabilityKey }).run()
    ).resolves.toEqual({ name: null, settled: true })

    const { run, connection } = generation({ capabilityKey })
    await run()
    expect(connection.request.mock.calls.map(([method]) => method)).not.toContain('turn/start')
  })

  it('propagates a non-capability failure from the name write', async () => {
    const { run, userConnection } = generation()
    userConnection.request.mockImplementation(async (method: string) => {
      if (method === 'thread/name/set') {
        throw new Error('transport died')
      }
      return { thread: { id: 'user', name: null } }
    })
    await expect(run()).rejects.toThrow('transport died')
  })

  it.each([null, '', 'prose', '{"title":" "}', JSON.stringify({ title: 'a'.repeat(9000) })])(
    'rejects unusable structured answers: %s',
    (answer) => {
      expect(readCodexGeneratedTitle(answer)).toBeNull()
    }
  )
})

describe('Codex naming response collection', () => {
  it.each(['failed', 'interrupted'])(
    'rejects a partial response from a %s turn',
    async (status) => {
      const collector = createCodexNamingTurnCollector(1000)
      collector.handle('item/completed', {
        item: { type: 'agentMessage', text: '{"title":"Partial"}' }
      })
      collector.handle('turn/completed', { turn: { status } })
      await expect(collector.answer).resolves.toEqual({ outcome: 'failed' })
    }
  )

  it('continues after a retryable error and rejects a terminal failure', async () => {
    const collector = createCodexNamingTurnCollector(1000)
    collector.handle('error', { willRetry: true })
    collector.handle('item/completed', {
      item: { type: 'agentMessage', text: '{"title":"partial"}' }
    })
    collector.handle('error', { willRetry: false })
    await expect(collector.answer).resolves.toEqual({ outcome: 'failed' })
  })

  it('disposes the deadline on completion and cancellation', async () => {
    vi.useFakeTimers()
    try {
      const collector = createCodexNamingTurnCollector(1000)
      collector.dispose()
      await expect(collector.answer).resolves.toEqual({ outcome: 'timed-out' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
