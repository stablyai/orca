import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveClaudeCommandMock, spawnMock } = vi.hoisted(() => ({
  resolveClaudeCommandMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: resolveClaudeCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

import { fetchViaPty } from './claude-pty'

function makeDisposable() {
  return { dispose: vi.fn() }
}

type MockTerm = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

function makeMockTerm(): MockTerm & {
  emitData: (data: string) => void
} {
  let dataHandler: ((data: string) => void) | null = null
  return {
    onData: vi.fn((handler: (data: string) => void) => {
      dataHandler = handler
      return makeDisposable()
    }),
    onExit: vi.fn(() => makeDisposable()),
    write: vi.fn(),
    kill: vi.fn(),
    emitData: (data: string) => dataHandler?.(data)
  }
}

describe('fetchViaPty', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveClaudeCommandMock.mockReturnValue('claude')
  })

  it('disposes node-pty listeners before killing the hidden PTY on timeout', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()

    spawnMock.mockReturnValue({
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(25_000)
    await resultPromise

    const term = spawnMock.mock.results[0]?.value as { kill: ReturnType<typeof vi.fn> }
    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      term.kill.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      term.kill.mock.invocationCallOrder[0]
    )
  })

  it('treats Claude 2.1 tabbed /usage session stats as rendered but unavailable', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(term.write).toHaveBeenCalledWith('/usage\r')

    term.emitData(`
      Settings  Status  Config   Usage  Stats

      Session
      Total cost: $0.0000
      Usage: 0 input, 0 output, 0 cache read, 0 cache write
    `)

    await vi.advanceTimersByTimeAsync(8_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      session: null,
      weekly: null,
      error: 'Claude plan usage is unavailable for this Claude CLI session.'
    })
    expect(term.write).not.toHaveBeenCalledWith('\x1b[D\x1b[D')
  })

  it('uses applyEnvFromMaterialization when preparation.materialization is set (non-OAuth provider)', async () => {
    // Why: T12.5 — non-OAuth providers ship credentials in `materialization`.
    // Verify the spawned env carries ANTHROPIC_API_KEY and that any stale
    // OAuth/provider env in process.env is stripped by the allowlist path.
    const priorOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-oauth-token'
    try {
      const term = makeMockTerm()
      spawnMock.mockReturnValue(term)

      const resultPromise = fetchViaPty({
        authPreparation: {
          configDir: '/tmp/claude',
          envPatch: {},
          stripAuthEnv: true,
          provenance: 'managed:api-key-account',
          materialization: {
            envPatch: {
              ANTHROPIC_API_KEY: 'sk-ant-test-1234'
            }
          }
        }
      })

      // node-pty is dynamically imported, so spawn happens on a microtask
      // after fetchViaPty resolves the import — flush before inspecting.
      await vi.advanceTimersByTimeAsync(0)
      const spawnArgs = spawnMock.mock.calls.at(-1) as
        | [string, string[], { env: Record<string, string> }]
        | undefined
      expect(spawnArgs).toBeDefined()
      const spawnedEnv = spawnArgs![2].env
      expect(spawnedEnv.ANTHROPIC_API_KEY).toBe('sk-ant-test-1234')
      // The allowlist-replace path strips the stale provider env.
      expect(spawnedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      // TERM still gets through (it's not a provider key).
      expect(spawnedEnv.TERM).toBe('xterm-256color')

      // Drain the pending fetch promise so vitest doesn't warn.
      await vi.advanceTimersByTimeAsync(25_000)
      await resultPromise
    } finally {
      if (priorOauth === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = priorOauth
      }
    }
  })

  it('falls back to applyClaudeEnvPatch when preparation.materialization is undefined (OAuth)', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty({
      authPreparation: {
        configDir: '/tmp/claude-oauth',
        envPatch: { CLAUDE_CONFIG_DIR: '/tmp/claude-oauth' },
        stripAuthEnv: true,
        provenance: 'managed:oauth-account'
      }
    })

    await vi.advanceTimersByTimeAsync(0)
    const spawnArgs = spawnMock.mock.calls.at(-1) as
      | [string, string[], { env: Record<string, string> }]
      | undefined
    expect(spawnArgs).toBeDefined()
    const spawnedEnv = spawnArgs![2].env
    expect(spawnedEnv.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-oauth')
    // No materialization, so ANTHROPIC_API_KEY is not injected.
    expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined()

    await vi.advanceTimersByTimeAsync(25_000)
    await resultPromise
  })

  it('keeps waiting for plan windows after the Claude 2.1 usage shell renders', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Settings  Status  Config   Usage  Stats
      Session
      Total cost: $0.0000
    `)

    await vi.advanceTimersByTimeAsync(1_000)
    term.emitData('Current session\r12% used\rResets 4:00pm\rCurrent week (all models)\r34% used\r')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 12,
        resetDescription: '4:00pm'
      },
      weekly: {
        usedPercent: 34
      },
      error: null
    })
  })
})
