import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SpawnEnv = Record<string, string | undefined>

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn<(command: string, args: string[], options: { env: SpawnEnv }) => unknown>()
}))

// The claude-teams handler spawns `claude` via node:child_process; mock it so we
// can inspect the child env without launching a real process.
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// Keep the socket runtime client out of the import graph; only the error type
// and serveOrcaApp binding are referenced by the module under test.
vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  serveOrcaApp: vi.fn()
}))

import { CORE_HANDLERS } from './core'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

// Minimal child stub: the handler only awaits `exit`, so resolve it on the next
// microtask to complete the spawned-process promise deterministically.
function mockClaudeChild(): { once: (event: string, cb: (...args: unknown[]) => void) => unknown } {
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'exit') {
        queueMicrotask(() => cb(0, null))
      }
      return child
    }
  }
  return child
}

function lastSpawnEnv(): SpawnEnv {
  const env = spawnMock.mock.calls.at(-1)?.[2].env
  if (!env) {
    throw new Error('claude was not spawned')
  }
  return env
}

describe('orca claude-teams CLI handler', () => {
  const isWindows = process.platform === 'win32'
  let previousRunAsNode: string | undefined
  let previousPaneKey: string | undefined
  let previousExitCode: typeof process.exitCode

  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  function runClaudeTeams(rawArgs: string[] = []): Promise<void> {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs
    }
    return CORE_HANDLERS['claude-teams'](ctx)
  }

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => mockClaudeChild())
    callMock.mockReset()
    callMock.mockResolvedValue({
      result: {
        launch: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PATH: '/shim:/usr/bin' } }
      }
    })
    previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    previousPaneKey = process.env.ORCA_PANE_KEY
    previousExitCode = process.exitCode
    // The `orca` launcher runs Orca's Electron binary as Node, so the CLI process
    // itself carries ELECTRON_RUN_AS_NODE=1. Reproduce that inherited flag here.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
  })

  afterEach(() => {
    if (previousRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode
    }
    if (previousPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = previousPaneKey
    }
    process.exitCode = previousExitCode
  })

  // Guarded to non-Windows: the handler early-returns unsupported_platform on
  // win32, so the leak path never runs there.
  it.skipIf(isWindows)(
    'does not leak ELECTRON_RUN_AS_NODE into the spawned claude child',
    async () => {
      await runClaudeTeams()

      expect(spawnMock).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object))
      const spawnEnv = lastSpawnEnv()
      expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()

      // The prepareLaunch request env is built from the same helper, so it must
      // be sanitized too.
      const prepareLaunchEnv = (callMock.mock.calls[0][1] as { env: SpawnEnv }).env
      expect(prepareLaunchEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  )

  it.skipIf(isWindows)(
    'still forwards non-Electron parent env and prepareLaunch env to claude',
    async () => {
      const previousMarker = process.env.ORCA_TEST_MARKER
      process.env.ORCA_TEST_MARKER = 'keep-me'
      try {
        await runClaudeTeams()
      } finally {
        if (previousMarker === undefined) {
          delete process.env.ORCA_TEST_MARKER
        } else {
          process.env.ORCA_TEST_MARKER = previousMarker
        }
      }

      const spawnEnv = lastSpawnEnv()
      expect(spawnEnv.ORCA_TEST_MARKER).toBe('keep-me')
      expect(spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
      expect(spawnEnv.PATH).toBe('/shim:/usr/bin')
    }
  )

  it.skipIf(isWindows)('removes managed auth variables before spawning Claude', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited'
    callMock.mockResolvedValueOnce({
      result: {
        launch: {
          env: {
            CLAUDE_CONFIG_DIR: '/managed/claude',
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
          },
          envToDelete: ['ANTHROPIC_API_KEY']
        }
      }
    })
    try {
      await runClaudeTeams()
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }

    const spawnEnv = lastSpawnEnv()
    expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe('/managed/claude')
  })

  it.skipIf(isWindows)('preserves API-key auth when no managed deletion is requested', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-system'
    try {
      await runClaudeTeams()
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }

    const spawnEnv = lastSpawnEnv()
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('sk-ant-system')
  })

  describe('--teammate-mode iterm2', () => {
    const it2LaunchEnv = {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      PATH: '/it2-shim:/usr/bin',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: '/it2-shim/probe-shell'
    }
    let previousShell: string | undefined
    let previousClaudeShell: string | undefined

    beforeEach(() => {
      previousShell = process.env.SHELL
      previousClaudeShell = process.env.CLAUDE_CODE_SHELL
      process.env.SHELL = '/bin/zsh'
      delete process.env.CLAUDE_CODE_SHELL
    })

    afterEach(() => {
      if (previousShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = previousShell
      }
      if (previousClaudeShell === undefined) {
        delete process.env.CLAUDE_CODE_SHELL
      } else {
        process.env.CLAUDE_CODE_SHELL = previousClaudeShell
      }
    })

    it.skipIf(isWindows)(
      'requests it2 launch env and routes the Claude shell probe through the wrapper',
      async () => {
        callMock.mockResolvedValueOnce({ result: { launch: { env: it2LaunchEnv } } })

        await runClaudeTeams(['--teammate-mode', 'iterm2'])

        expect(callMock.mock.calls[0][1]).toMatchObject({ teammateMode: 'iterm2' })
        expect(spawnMock).toHaveBeenCalledWith(
          'claude',
          ['--teammate-mode', 'iterm2'],
          expect.any(Object)
        )
        const spawnEnv = lastSpawnEnv()
        expect(spawnEnv.SHELL).toBe('/it2-shim/probe-shell')
        expect(spawnEnv.ORCA_AGENT_TEAMS_REAL_SHELL).toBe('/bin/zsh')
        expect(spawnEnv.CLAUDE_CODE_SHELL).toBe('/bin/zsh')
      }
    )

    it.skipIf(isWindows)(
      'keeps an explicit CLAUDE_CODE_SHELL and non-bash/zsh shells',
      async () => {
        process.env.SHELL = '/usr/bin/fish'
        callMock.mockResolvedValueOnce({ result: { launch: { env: it2LaunchEnv } } })
        await runClaudeTeams(['--teammate-mode=iterm2'])
        const fishEnv = lastSpawnEnv()
        expect(fishEnv.CLAUDE_CODE_SHELL).toBeUndefined()

        process.env.SHELL = '/bin/zsh'
        process.env.CLAUDE_CODE_SHELL = '/opt/custom-bash'
        callMock.mockResolvedValueOnce({ result: { launch: { env: it2LaunchEnv } } })
        await runClaudeTeams(['--teammate-mode=iterm2'])
        const customEnv = lastSpawnEnv()
        expect(customEnv.CLAUDE_CODE_SHELL).toBe('/opt/custom-bash')
      }
    )

    it.skipIf(isWindows)(
      'refuses to start Claude when the runtime predates iTerm2 support',
      async () => {
        await expect(runClaudeTeams(['--teammate-mode', 'iterm2'])).rejects.toMatchObject({
          code: 'incompatible_runtime'
        })
        expect(spawnMock).not.toHaveBeenCalled()
      }
    )

    it.skipIf(isWindows)(
      'leaves tmux launches and prompts naming iterm2 without a teammate mode or shell rewrite',
      async () => {
        await runClaudeTeams(['--teammate-mode', 'tmux', '-p', 'try --teammate-mode iterm2'])

        expect(callMock.mock.calls[0][1]).not.toHaveProperty('teammateMode')
        const spawnEnv = lastSpawnEnv()
        expect(spawnEnv.SHELL).toBe('/bin/zsh')
        expect(spawnEnv.ORCA_AGENT_TEAMS_REAL_SHELL).toBeUndefined()
      }
    )
  })
})
