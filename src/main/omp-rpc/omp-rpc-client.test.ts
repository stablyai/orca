import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpRpcClientEvent, OmpRpcSessionState } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient, type OmpRpcClient } from './omp-rpc-client'
import { OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS } from './omp-rpc-transport-limits'

const clients = new Set<OmpRpcClient>()
const temporaryDirectories = new Set<string>()

function spawnScenario(scenario: Parameters<typeof createFakeOmpRpcChild>[0]): OmpRpcClient {
  const client = spawnOmpRpcClient(createFakeOmpRpcChild(scenario).spawnOptions)
  clients.add(client)
  return client
}

function spawnSessionScenario(scenario: Parameters<typeof createFakeOmpRpcChild>[0]): OmpRpcClient {
  const client = spawnOmpRpcClient(createFakeOmpRpcChild(scenario, 'session-owning').spawnOptions)
  clients.add(client)
  return client
}

afterEach(async () => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
  )
  temporaryDirectories.clear()
})

describe('OMP RPC client negotiation', () => {
  it('resolves readiness only after negotiating protocol v2', async () => {
    const client = spawnScenario({})

    await expect(client.whenReady()).resolves.toEqual({
      ready: {
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864
      },
      negotiatedProtocolVersion: 2
    })
  })

  it('faults when negotiation succeeds but does not select protocol v2', async () => {
    const client = spawnScenario({
      negotiationResponse: {
        id: 'orca-omp-1',
        type: 'response',
        command: 'negotiate_protocol',
        success: true,
        data: { protocolVersion: 1 }
      }
    })

    await expect(client.whenReady()).rejects.toThrow(
      'OMP RPC protocol v2 negotiation failed: response did not select protocol v2'
    )
  })

  it('rejects and emits a protocol fault for a malformed first frame', async () => {
    const client = spawnScenario({ firstFrame: { type: 'command_output', text: 'too early' } })
    const events: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        events.push(event.message)
      }
    })

    await expect(client.whenReady()).rejects.toThrow('valid ready frame')
    expect(events).toEqual(['OMP RPC first frame was not a valid ready frame'])
  })

  // The ready frame advertises the SERVER's framing envelope so a client can
  // adapt to it; OMP ships independently of Orca, so another release's
  // numbers must be adopted, not rejected as "not a ready frame".
  it('adopts a smaller framing envelope that differs from its own defaults', async () => {
    const client = spawnScenario({
      readyFrameOverrides: { maxFrameBytes: 524_288, maxReassembledFrameBytes: 4_194_304 }
    })

    await expect(client.whenReady()).resolves.toMatchObject({
      ready: { maxFrameBytes: 524_288, maxReassembledFrameBytes: 4_194_304 }
    })
  })

  it('rejects a peer-controlled framing envelope above the local memory ceilings', async () => {
    const client = spawnScenario({
      readyFrameOverrides: {
        maxFrameBytes: Number.MAX_SAFE_INTEGER,
        maxReassembledFrameBytes: Number.MAX_SAFE_INTEGER
      }
    })

    await expect(client.whenReady()).rejects.toThrow('valid ready frame')
  })

  it('rejects an envelope that is not a usable pair of positive byte counts', async () => {
    const client = spawnScenario({
      readyFrameOverrides: { maxFrameBytes: 4_096, maxReassembledFrameBytes: 1_024 }
    })

    await expect(client.whenReady()).rejects.toThrow('valid ready frame')
  })

  it('rejects readiness when protocol v2 negotiation fails', async () => {
    const client = spawnScenario({
      negotiationResponse: {
        id: 'orca-omp-1',
        type: 'response',
        command: 'negotiate_protocol',
        success: false,
        error: 'Protocol rejected',
        code: 'E_PROTOCOL'
      }
    })

    await expect(client.whenReady()).rejects.toThrow(
      'OMP RPC protocol v2 negotiation failed: Protocol rejected'
    )
  })

  it('omits --no-session only for an explicit session-owning spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-omp-rpc-'))
    temporaryDirectories.add(directory)
    const argvMarkerPath = join(directory, 'argv.json')
    const client = spawnSessionScenario({ argvMarkerPath })

    await client.whenReady()

    await expect
      .poll(async () => JSON.parse(await readFile(argvMarkerPath, 'utf8')))
      .toEqual(['--mode', 'rpc'])
  })

  it('rejects --no-session in session-owning extra arguments', () => {
    const fake = createFakeOmpRpcChild({}, 'session-owning')
    let client: OmpRpcClient | undefined

    try {
      expect(() => {
        client = spawnOmpRpcClient({
          ...fake.spawnOptions,
          extraArgs: ['--no-session', ...(fake.spawnOptions.extraArgs ?? [])]
        })
      }).toThrow('session-owning OMP RPC spawn cannot include --no-session')
    } finally {
      client?.dispose()
    }
  })
})

describe('OMP RPC session ownership commands', () => {
  it('reads state, aborts streaming work, and switches the owned session', async () => {
    const streamingState: OmpRpcSessionState = {
      sessionFile: '/sessions/first.jsonl',
      sessionId: 'session-first',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const client = spawnSessionScenario({ sessionState: streamingState })
    await client.whenReady()

    await expect(client.getState()).resolves.toEqual(streamingState)
    await client.abort()
    await expect(client.getState()).resolves.toMatchObject({ isStreaming: false })
    await client.switchSession('/sessions/second.jsonl')
    await expect(client.getState()).resolves.toMatchObject({
      sessionFile: '/sessions/second.jsonl'
    })
  })

  // Reading the level back off the server's own response is the point: a
  // client that assumed its request took would wait forever for forwarded
  // frames the server never turned on.
  it('rejects a subagent subscription whose response reports no usable level', async () => {
    const client = spawnSessionScenario({
      commandErrors: {
        set_subagent_subscription: { error: 'Subagent event bus is unavailable' }
      }
    })
    await client.whenReady()
    await expect(client.setSubagentSubscription('progress')).rejects.toThrow(
      'Subagent event bus is unavailable'
    )
  })
})

describe('OMP RPC command catalog', () => {
  it('returns correlated commands and emits pushed and returned catalogs', async () => {
    const commands = [
      {
        name: 'usage',
        aliases: ['u'],
        description: 'Show token usage',
        input: { hint: '' },
        source: 'built-in'
      }
    ]
    const client = spawnScenario({
      commands,
      afterNegotiationFrames: [{ type: 'available_commands_update', commands }]
    })
    const catalogs: unknown[] = []
    client.on((event) => {
      if (event.kind === 'commands') {
        catalogs.push(event.commands)
      }
    })

    await client.whenReady()
    await expect(client.getCommands()).resolves.toEqual(commands)
    await vi.waitFor(() => expect(catalogs).toEqual([commands, commands]))
  })
})

describe('OMP RPC idle recap', () => {
  it('emits typed recap updates, including invalidation', async () => {
    const recap = { text: 'Mapped the RPC surface.', trigger: 'idle' as const, timestamp: 1234 }
    const client = spawnScenario({
      afterNegotiationFrames: [
        { type: 'recap_update', recap },
        { type: 'recap_update', recap: null }
      ]
    })
    const updates: (typeof recap | null)[] = []
    client.on((event) => {
      if (event.kind === 'recap-update') {
        updates.push(event.recap)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(updates).toEqual([recap, null]))
  })
})

describe('OMP RPC builtin-command side channels', () => {
  it('emits typed session_info_update and config_update frames', async () => {
    const client = spawnScenario({
      afterNegotiationFrames: [
        { type: 'session_info_update', title: 'RPC parity', sessionId: 'sess-1' },
        {
          type: 'config_update',
          model: { id: 'claude-opus-5', name: 'Opus 5', provider: 'anthropic' },
          thinkingLevel: 'high'
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => {
      if (event.kind === 'session-info' || event.kind === 'config-update') {
        events.push(event)
      }
    })

    await client.whenReady()
    await vi.waitFor(() =>
      expect(events).toEqual([
        { kind: 'session-info', title: 'RPC parity', sessionId: 'sess-1' },
        {
          kind: 'config-update',
          model: { id: 'claude-opus-5', name: 'Opus 5', provider: 'anthropic' },
          thinkingLevel: 'high'
        }
      ])
    )
  })

  it('normalizes the absent fields OMP omits when the session has no name or model', async () => {
    // `session.sessionName`/`session.model` are `| undefined` upstream, and JSON
    // drops an undefined property — so both frames legitimately arrive bare.
    const client = spawnScenario({
      afterNegotiationFrames: [{ type: 'session_info_update' }, { type: 'config_update' }]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => {
      if (event.kind === 'session-info' || event.kind === 'config-update') {
        events.push(event)
      }
    })

    await client.whenReady()
    await vi.waitFor(() =>
      expect(events).toEqual([
        { kind: 'session-info', title: null, sessionId: null },
        { kind: 'config-update', model: null, thinkingLevel: null }
      ])
    )
  })

  // One client per case: `protocolFault` latches on the first fault, so a
  // second malformed frame on the same client is deliberately never re-emitted.
  it.each([
    [{ type: 'session_info_update', title: 42 }, 'session_info_update'],
    [{ type: 'config_update', model: 'claude-opus-5' }, 'config_update'],
    [{ type: 'config_update', thinkingLevel: 3 }, 'config_update']
  ])('faults instead of guessing when %o is the wrong shape', async (badFrame, frameType) => {
    const client = spawnScenario({ afterNegotiationFrames: [badFrame] })
    const faults: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        faults.push(event.message)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(faults).toEqual([`OMP RPC ${frameType} frame was malformed`]))
  })
})

describe('OMP RPC prompts', () => {
  it('settles a local command from its successful agent-free response without a terminal frame', async () => {
    const client = spawnScenario({
      promptImmediateAcknowledgement: true,
      promptOutput: ['## Usage\n12% used'],
      promptEvents: [{ type: 'agent_end', isTerminal: false }],
      promptAgentInvoked: false
    })

    await client.whenReady()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(
        Promise.race([
          client.prompt('/usage'),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('local command did not settle')), 1_000)
          })
        ])
      ).resolves.toEqual({ agentInvoked: false })
    } finally {
      clearTimeout(timeout)
    }
  })

  it('emits slash-command output before resolving an agent-free prompt', async () => {
    const client = spawnScenario({
      promptOutput: ['## Usage\n12% used'],
      promptResultAgentInvoked: false,
      promptAgentInvoked: false
    })
    const order: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        order.push(`output:${event.text}`)
      }
      if (event.kind === 'prompt-result') {
        order.push(`result:${event.agentInvoked}`)
      }
    })

    await client.whenReady()
    const result = await client.prompt('/usage').then((value) => {
      order.push('resolved')
      return value
    })

    expect(result).toEqual({ agentInvoked: false })
    expect(order).toEqual(['output:## Usage\n12% used', 'result:false', 'resolved'])
  })

  it('sends a caller-supplied request id so a later frame can be correlated', async () => {
    // OMP echoes the request id on prompt_result (rpc-mode.ts:152-156), and it
    // is the only handle the renderer has for telling one command run's
    // local-only report from another's — command_output carries no id at all.
    // The caller therefore owns the id, and owns it BEFORE the send, so the
    // capture slot is bound before any frame for it can arrive.
    const client = spawnScenario({ promptResultAgentInvoked: false, promptAgentInvoked: false })
    const promptResults: (string | undefined)[] = []
    client.on((event) => {
      if (event.kind === 'prompt-result') {
        promptResults.push(event.id)
      }
    })

    await client.whenReady()
    await client.prompt('/deploy', { requestId: 'omp-command-7' })

    await vi.waitFor(() => expect(promptResults).toEqual(['omp-command-7']))
  })

  it('refuses a request id that could collide with the auto-allocated sequence', async () => {
    const client = spawnScenario({})
    await client.whenReady()

    await expect(client.prompt('/deploy', { requestId: 'orca-omp-3' })).rejects.toThrow(
      'request id'
    )
    await expect(client.prompt('/deploy', { requestId: '' })).rejects.toThrow('request id')
  })

  it('refuses a request id already in flight, which would settle the wrong command', async () => {
    const client = spawnScenario({})
    await client.whenReady()

    const first = client.prompt('/deploy', { requestId: 'omp-command-8' })
    await expect(client.prompt('/deploy', { requestId: 'omp-command-8' })).rejects.toThrow(
      'request id'
    )
    await expect(first).resolves.toEqual({ agentInvoked: true })
  })

  it('refuses a caller request id after its response settles', async () => {
    // `prompt_result` is a separate server-push frame and may arrive after
    // this response releases pendingResponses. Reusing the id would let that
    // late report mutate the later command's renderer capture slot.
    const client = spawnScenario({})
    await client.whenReady()

    await expect(client.prompt('/deploy', { requestId: 'omp-command-9' })).resolves.toEqual({
      agentInvoked: true
    })
    await expect(client.prompt('/help', { requestId: 'omp-command-9' })).rejects.toThrow(
      'request id'
    )
  })

  it('defaults an absent prompt response payload to agent-invoking', async () => {
    const client = spawnScenario({})
    await client.whenReady()

    await expect(client.prompt('Explain this')).resolves.toEqual({ agentInvoked: true })
  })

  it('rejects an error response with its message and code', async () => {
    const client = spawnScenario({
      commandErrors: { prompt: { error: 'Prompt denied', code: 'E_DENIED' } }
    })
    await client.whenReady()

    await expect(client.prompt('Explain this')).rejects.toMatchObject({
      message: 'Prompt denied',
      code: 'E_DENIED'
    })
  })

  it('rejects a prompt when asynchronous scheduling fails after its acknowledgement', async () => {
    const client = spawnScenario({
      promptImmediateAcknowledgement: true,
      promptAsyncError: { error: 'Extension scheduling failed', code: 'E_EXTENSION' }
    })
    await client.whenReady()

    await expect(client.prompt('/extension')).rejects.toMatchObject({
      message: 'Extension scheduling failed',
      code: 'E_EXTENSION'
    })
  })
})

describe('OMP RPC v2 chunking', () => {
  it('reassembles an oversized logical frame before dispatch', async () => {
    const textLength = 1_100_000
    const client = spawnScenario({ chunkedCommandOutputLength: textLength })
    const output: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        output.push(event.text)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(output).toHaveLength(1))
    expect(output[0]).toBe('x'.repeat(textLength))
  })

  it('accepts a chunked frame sized to a smaller advertised envelope', async () => {
    // Under the pinned 1 MiB default this byteLength would be rejected as
    // "outside the permitted range"; the server's own envelope decides. The
    // envelope still has to fit one base64 chunk line (256 KiB payload).
    const textLength = 600_000
    const client = spawnScenario({
      readyFrameOverrides: { maxFrameBytes: 524_288, maxReassembledFrameBytes: 4_194_304 },
      chunkedCommandOutputLength: textLength
    })
    const output: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        output.push(event.text)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(output).toHaveLength(1))
    expect(output[0]).toBe('x'.repeat(textLength))
  })

  it.each([
    ['wrong-start-index', 'index 0'],
    ['chunk-id-mismatch', 'metadata'],
    ['interleaved-frame', 'non-chunk'],
    ['byte-length-mismatch', 'byte length']
  ] as const)('surfaces %s as a protocol fault', async (chunkFault, expectedMessage) => {
    const client = spawnScenario({
      chunkedCommandOutputLength: 1_100_000,
      chunkFault
    })
    const faults: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        faults.push(event.message)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(faults).toHaveLength(1))
    expect(faults[0]).toContain(expectedMessage)
  })
})

describe('OMP RPC transport lifecycle', () => {
  it('preserves an unrecognized parsed frame', async () => {
    const frame = { type: 'agent_custom_event', sequence: 4, payload: { state: 'working' } }
    const client = spawnScenario({ afterNegotiationFrames: [frame] })
    const unknownFrames: unknown[] = []
    client.on((event) => {
      if (event.kind === 'unknown-frame') {
        unknownFrames.push(event.frame)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(unknownFrames).toEqual([frame]))
  })

  it('surfaces malformed JSON with an excerpt bounded to 200 characters', async () => {
    const malformedLine = `{"type":"broken","payload":"${'z'.repeat(500)}`
    const client = spawnScenario({ malformedAfterNegotiationLine: malformedLine })
    const faults: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        faults.push(event.message)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(faults).toHaveLength(1))
    expect(faults[0]).toContain(malformedLine.slice(0, 200))
    expect(faults[0]).not.toContain(malformedLine.slice(0, 201))
    // A protocol-faulted child remains a potential writer until it exits.
    // The client owns that process, so the fatal transport path must terminate it.
    await expect(client.whenExited()).resolves.toMatchObject({ signal: 'SIGTERM' })
  })

  it('rejects a pending command when the child exits and includes bounded stderr', async () => {
    const stderr = `${'x'.repeat(9_000)}diagnostic-tail`
    const client = spawnScenario({
      exitOnCommand: 'prompt',
      exitCode: 17,
      stderrBeforeExit: stderr
    })
    const exits: unknown[] = []
    client.on((event) => {
      if (event.kind === 'exit') {
        exits.push(event)
      }
    })
    await client.whenReady()

    await expect(client.prompt('exit now')).rejects.toThrow('diagnostic-tail')
    expect(client.stderrTail).toHaveLength(8_192)
    expect(client.stderrTail.endsWith('diagnostic-tail')).toBe(true)
    await vi.waitFor(() => expect(exits).toEqual([{ kind: 'exit', code: 17, signal: null }]))
  })

  it('terminates the child on dispose and emits one exit event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-omp-rpc-'))
    temporaryDirectories.add(directory)
    const markerPath = join(directory, 'signal.txt')
    const client = spawnScenario({ sigtermMarkerPath: markerPath })
    const exits: unknown[] = []
    client.on((event) => {
      if (event.kind === 'exit') {
        exits.push(event)
      }
    })
    await client.whenReady()

    client.dispose()

    await vi.waitFor(async () => expect(await readFile(markerPath, 'utf8')).toBe('SIGTERM'))
    await expect(client.whenExited()).resolves.toMatchObject({ code: 0, signal: null })
    await vi.waitFor(() => expect(exits).toHaveLength(1))
  })
})

describe('OMP RPC history hydration', () => {
  it('drains a multi-page history over the wire in order', async () => {
    const history = Array.from({ length: 5 }, (_, index) => ({ role: 'user', text: `m${index}` }))
    const client = spawnSessionScenario({ historyMessages: history })

    await expect(client.fetchHistory({ limit: 2 })).resolves.toEqual({
      kind: 'complete',
      messages: history,
      totalMessages: 5
    })
  })

  it('reports session-busy instead of failing when the session refuses to page', async () => {
    const client = spawnSessionScenario({
      commandErrors: {
        get_messages_page: {
          error: 'Cannot page messages while the session is changing',
          code: 'session_busy'
        }
      }
    })

    await expect(client.fetchHistory()).resolves.toEqual({ kind: 'session-busy' })
  })

  it('rejects a malformed history page rather than hydrating a partial list', async () => {
    const client = spawnSessionScenario({
      historyMalformedPage: { messages: [{ role: 'user' }], totalMessages: 'many' }
    })

    await expect(client.getMessagesPage()).rejects.toThrow(
      'OMP RPC message page response was malformed'
    )
  })

  // XLR-016 (cross-lab review): the child stays alive and keeps reading stdin,
  // it just never answers. Without a response deadline every wait built on
  // `getState` — the settle poll, the release that follows it, the acquire
  // queued behind that release — is unbounded, and the pane's PTY is already
  // gone by then.
  it('rejects a query whose response never arrives instead of pending forever', async () => {
    const client = spawnSessionScenario({ swallowCommands: ['get_state'] })
    await client.whenReady()

    vi.useFakeTimers()
    try {
      const state = client.getState()
      const assertion = expect(state).rejects.toThrow(
        `OMP RPC get_state did not answer within ${OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS}ms`
      )
      await vi.advanceTimersByTimeAsync(OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  // The same deadline must never touch a turn command: upstream answers
  // `prompt` only after the skill/builtin it dispatches has finished running,
  // so a deadline there would abandon live work.
  it('leaves a turn command without a deadline', async () => {
    const client = spawnSessionScenario({ swallowCommands: ['prompt'] })
    await client.whenReady()

    vi.useFakeTimers()
    try {
      let settled = false
      void client.prompt('hello').then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await vi.advanceTimersByTimeAsync(OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS * 3)
      expect(settled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends no cursor on the first page and echoes the server cursor verbatim after', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-omp-rpc-'))
    temporaryDirectories.add(directory)
    const markerPath = join(directory, 'pages.jsonl')
    const client = spawnSessionScenario({
      historyMessages: Array.from({ length: 3 }, (_, index) => ({ text: `m${index}` })),
      historyPageMarkerPath: markerPath
    })

    await client.fetchHistory({ limit: 1 })

    const requests = (await readFile(markerPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { cursor?: string; limit?: number })
    expect(requests.map((request) => request.cursor)).toEqual([undefined, '1', '2'])
    expect(requests.every((request) => request.limit === 1)).toBe(true)
  })
})
