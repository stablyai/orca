import { describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcClientEvent,
  OmpRpcClientLike,
  OmpRpcSlashCommand,
  OmpRpcSpawnOptions
} from '../../shared/omp-rpc-protocol'
import { createOmpRpcProbePool } from './omp-rpc-probe-pool'

type FakeClient = OmpRpcClientLike & {
  emit: (event: OmpRpcClientEvent) => void
  disposed: boolean
  options: OmpRpcSpawnOptions
  promptCalls: string[]
}

function createFakeClient(
  options: OmpRpcSpawnOptions,
  overrides: {
    commands?: OmpRpcSlashCommand[]
    /** Output frames emitted synchronously while the prompt is in flight. */
    outputs?: string[]
    agentInvoked?: boolean
    readyRejects?: boolean
    promptRejects?: boolean
    commandsRejects?: boolean
  } = {}
): FakeClient {
  const listeners = new Set<(event: OmpRpcClientEvent) => void>()
  const client: FakeClient = {
    options,
    disposed: false,
    promptCalls: [],
    emit: (event) => {
      // Snapshot: a listener may unsubscribe itself while handling the event.
      for (const listener of Array.from(listeners)) {
        listener(event)
      }
    },
    whenReady: () =>
      overrides.readyRejects
        ? Promise.reject(new Error('no ready frame'))
        : Promise.resolve({
            ready: {
              type: 'ready' as const,
              protocolVersion: 1 as const,
              supportedProtocolVersions: [1, 2],
              maxFrameBytes: 1024,
              maxReassembledFrameBytes: 4096
            },
            negotiatedProtocolVersion: 2
          }),
    getCommands: () =>
      overrides.commandsRejects
        ? Promise.reject(new Error('catalog read failed'))
        : Promise.resolve(overrides.commands ?? [{ name: 'usage' }]),
    prompt: (message) => {
      client.promptCalls.push(message)
      if (overrides.promptRejects) {
        return Promise.reject(new Error('prompt failed'))
      }
      for (const text of overrides.outputs ?? []) {
        client.emit({ kind: 'command-output', text })
      }
      return Promise.resolve({ agentInvoked: overrides.agentInvoked ?? false })
    },
    steer: () => Promise.resolve({ agentInvoked: true }),
    followUp: () => Promise.resolve({ agentInvoked: true }),
    respondExtensionUi: () => true,
    on: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      client.disposed = true
    },
    whenExited: () => Promise.resolve({ code: 0, signal: null })
  }
  return client
}

function createPool(
  overrides: Parameters<typeof createFakeClient>[1] = {},
  deps: { executablePath?: string | null } = {}
): {
  pool: ReturnType<typeof createOmpRpcProbePool>
  clients: FakeClient[]
  spawn: ReturnType<typeof vi.fn>
} {
  const clients: FakeClient[] = []
  const spawn = vi.fn((options: OmpRpcSpawnOptions) => {
    const client = createFakeClient(options, overrides)
    clients.push(client)
    return client
  })
  const pool = createOmpRpcProbePool({
    resolveExecutablePath: async () =>
      deps.executablePath === undefined
        ? { executablePath: 'omp' }
        : deps.executablePath
          ? { executablePath: deps.executablePath }
          : null,
    spawn
  })
  return { pool, clients, spawn }
}

describe('OMP RPC probe pool', () => {
  it('resolves the OMP executable independently of the workspace cwd', async () => {
    const resolveExecutablePath = vi.fn(async () => ({ executablePath: 'omp' }))
    const spawn = vi.fn((options: OmpRpcSpawnOptions) => createFakeClient(options))
    const pool = createOmpRpcProbePool({ resolveExecutablePath, spawn })

    await pool.getCommands('/work/a')

    expect(resolveExecutablePath).toHaveBeenCalledWith()
  })

  it('spawns exactly one session-less probe per cwd and reuses the cached catalog', async () => {
    const { pool, clients, spawn } = createPool({ commands: [{ name: 'usage' }, { name: 'help' }] })

    const first = await pool.getCommands('/work/a')
    const second = await pool.getCommands('/work/a')

    expect(first).toEqual({ ok: true, commands: [{ name: 'usage' }, { name: 'help' }] })
    expect(second).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
    // The probe must never contend with the pane's live TUI session.
    expect(clients[0]?.options).toMatchObject({ cwd: '/work/a', noSession: true })
    // Second read is served from cache, not a second wire round-trip.
    expect(clients).toHaveLength(1)
  })

  it('keys probes by cwd so two workspaces never share one child', async () => {
    const { pool, spawn } = createPool()
    await pool.getCommands('/work/a')
    await pool.getCommands('/work/b')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent first reads into a single spawn', async () => {
    const { pool, spawn } = createPool()
    await Promise.all([pool.getCommands('/work/a'), pool.getCommands('/work/a')])
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('refreshes the cached catalog from a pushed commands event', async () => {
    const { pool, clients } = createPool({ commands: [{ name: 'usage' }] })
    await pool.getCommands('/work/a')

    clients[0]?.emit({ kind: 'commands', commands: [{ name: 'usage' }, { name: 'model' }] })

    await expect(pool.getCommands('/work/a')).resolves.toEqual({
      ok: true,
      commands: [{ name: 'usage' }, { name: 'model' }]
    })
  })

  it('disposes and respawns after the child exits', async () => {
    const { pool, clients, spawn } = createPool()
    await pool.getCommands('/work/a')

    clients[0]?.emit({ kind: 'exit', code: 1, signal: null })
    expect(clients[0]?.disposed).toBe(true)

    await pool.getCommands('/work/a')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('runs /usage and returns its output with agentInvoked from the wire', async () => {
    const { pool, clients } = createPool({
      outputs: ['```\nUsage\n', 'total 12\n```'],
      agentInvoked: false
    })

    const result = await pool.runLocalCommand('/work/a', '/usage')

    expect(result).toEqual({
      ok: true,
      // Ordering is the contract: frames concatenate in arrival order.
      outputText: '```\nUsage\ntotal 12\n```',
      agentInvoked: false
    })
    expect(clients[0]?.promptCalls).toEqual(['/usage'])
  })

  it('rejects every command outside the allowlist without spawning', async () => {
    const { pool, spawn } = createPool()

    for (const command of ['/compact', '/clear', '/usage --json', 'usage', '/model opus']) {
      await expect(pool.runLocalCommand('/work/a', command)).resolves.toEqual({
        ok: false,
        errorCode: 'not-allowed'
      })
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('accepts /usage case-insensitively and with surrounding whitespace', async () => {
    const { pool } = createPool()
    await expect(pool.runLocalCommand('/work/a', '  /USAGE  ')).resolves.toMatchObject({ ok: true })
  })

  it('stops collecting output past the byte cap and flags truncation', async () => {
    const chunk = 'x'.repeat(1_500_000)
    const { pool } = createPool({ outputs: [chunk, chunk, chunk] })

    const result = await pool.runLocalCommand('/work/a', '/usage')

    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.ok && result.outputText).toBe(chunk)
  })

  it('maps a missing executable, a dead ready frame, and a failed request to codes', async () => {
    const missing = createPool({}, { executablePath: null })
    await expect(missing.pool.getCommands('/work/a')).resolves.toEqual({
      ok: false,
      errorCode: 'executable-not-found'
    })
    await expect(missing.pool.runLocalCommand('/work/a', '/usage')).resolves.toEqual({
      ok: false,
      errorCode: 'executable-not-found'
    })

    const notReady = createPool({ readyRejects: true })
    await expect(notReady.pool.getCommands('/work/a')).resolves.toEqual({
      ok: false,
      errorCode: 'not-ready'
    })

    const badCatalog = createPool({ commandsRejects: true })
    await expect(badCatalog.pool.getCommands('/work/a')).resolves.toEqual({
      ok: false,
      errorCode: 'request-failed'
    })

    const badPrompt = createPool({ promptRejects: true })
    await expect(badPrompt.pool.runLocalCommand('/work/a', '/usage')).resolves.toEqual({
      ok: false,
      errorCode: 'request-failed'
    })
  })

  it('maps a throwing spawn to spawn-failed instead of rejecting', async () => {
    const pool = createOmpRpcProbePool({
      resolveExecutablePath: async () => ({ executablePath: 'omp' }),
      spawn: () => {
        throw new Error('ENOENT')
      }
    })
    await expect(pool.getCommands('/work/a')).resolves.toEqual({
      ok: false,
      errorCode: 'spawn-failed'
    })
  })

  it('detaches the output listener once a prompt settles', async () => {
    const { pool, clients } = createPool({ outputs: ['first'] })
    const first = await pool.runLocalCommand('/work/a', '/usage')
    expect(first.ok && first.outputText).toBe('first')

    // Late output from the previous prompt must not leak into the next one.
    clients[0]?.emit({ kind: 'command-output', text: 'stale' })
    const second = await pool.runLocalCommand('/work/a', '/usage')
    expect(second.ok && second.outputText).toBe('first')
  })

  it('serializes overlapping local commands on one probe so neither collects the other', async () => {
    // Two panes in one workspace fire /usage at once. command_output frames
    // carry no request id, so the second run must not start until the first
    // prompt settles — otherwise both collectors see both outputs.
    let releaseFirst = (): void => {}
    let promptCount = 0
    const { pool, clients } = createPool()
    await pool.getCommands('/work/a')
    const client = clients[0]!
    client.prompt = () => {
      promptCount += 1
      const mine = promptCount
      if (mine === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => {
            client.emit({ kind: 'command-output', text: 'first' })
            resolve({ agentInvoked: false })
          }
        })
      }
      client.emit({ kind: 'command-output', text: 'second' })
      return Promise.resolve({ agentInvoked: false })
    }

    const first = pool.runLocalCommand('/work/a', '/usage')
    const second = pool.runLocalCommand('/work/a', '/usage')
    await vi.waitFor(() => expect(promptCount).toBe(1))
    // Give the second run every chance to start early; it must still be queued.
    await Promise.resolve()
    expect(promptCount).toBe(1)
    releaseFirst()

    const [a, b] = await Promise.all([first, second])
    expect(a.ok && a.outputText).toBe('first')
    expect(b.ok && b.outputText).toBe('second')
  })

  it('disposes every probe on shutdown and settles once they have exited', async () => {
    const { pool, clients } = createPool()
    await pool.getCommands('/work/a')
    await pool.getCommands('/work/b')

    await pool.dispose()

    expect(clients.map((client) => client.disposed)).toEqual([true, true])
  })

  it('retires a probe whose spawn resolves after dispose instead of registering it', async () => {
    let releaseExecutable = (): void => {}
    const clients: FakeClient[] = []
    const pool = createOmpRpcProbePool({
      resolveExecutablePath: () =>
        new Promise((resolve) => {
          releaseExecutable = () => resolve({ executablePath: 'omp' })
        }),
      spawn: (options) => {
        const client = createFakeClient(options)
        clients.push(client)
        return client
      }
    })

    const pending = pool.getCommands('/work/a')
    let disposeResolved = false
    const disposal = pool.dispose().then(() => {
      disposeResolved = true
    })
    await Promise.resolve()
    expect(disposeResolved).toBe(false)
    releaseExecutable()

    await disposal
    await expect(pending).resolves.toEqual({ ok: false, errorCode: 'executable-not-found' })
    expect(clients.map((client) => client.disposed)).toEqual([true])
  })
})
