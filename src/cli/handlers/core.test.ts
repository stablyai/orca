import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, resolveClaudeCommandMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveClaudeCommandMock: vi.fn(() => 'C:\\Program Files\\Claude\\claude.cmd')
}))

// The claude-teams handler spawns `claude` via node:child_process; mock it so we
// can inspect the child env without launching a real process.
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveClaudeCommand: resolveClaudeCommandMock
}))

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

type SpawnEnv = Record<string, string | undefined>

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

describe('orca claude-teams CLI handler', () => {
  let previousRunAsNode: string | undefined
  let previousPaneKey: string | undefined
  let previousExitCode: typeof process.exitCode

  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  function runClaudeTeams(): Promise<void> {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs: []
    }
    return CORE_HANDLERS['claude-teams'](ctx)
  }

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => mockClaudeChild())
    callMock.mockReset()
    callMock.mockResolvedValue({
      result: {
        launch: {
          mode: 'native',
          env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PATH: '/shim:/usr/bin' }
        }
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

  it('does not leak ELECTRON_RUN_AS_NODE into the spawned claude child', async () => {
    await runClaudeTeams()

    const spawnSpec = spawnMock.mock.calls.at(-1)?.[0]
    expect(spawnSpec).toMatchObject({
      program: 'C:\\Program Files\\Claude\\claude.cmd',
      args: ['--teammate-mode', 'auto'],
      stdio: 'inherit'
    })
    const spawnEnv = spawnSpec.env as SpawnEnv
    expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()

    // The prepareLaunch request env is built from the same helper, so it must
    // be sanitized too.
    const prepareLaunchEnv = (callMock.mock.calls[0][1] as { env: SpawnEnv }).env
    expect(prepareLaunchEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('still forwards non-Electron parent env and prepareLaunch env to claude', async () => {
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

    const spawnEnv = spawnMock.mock.calls.at(-1)?.[0].env as SpawnEnv
    expect(spawnEnv.ORCA_TEST_MARKER).toBe('keep-me')
    expect(spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(spawnEnv.PATH).toBe('/shim:/usr/bin')
  })

  it('keeps Windows batch-sensitive arguments structured', async () => {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: 'C:\\work tree',
      json: false,
      rawArgs: ['--prompt', 'space & caret ^ percent % bang !']
    }

    await CORE_HANDLERS['claude-teams'](ctx)

    expect(spawnMock.mock.calls.at(-1)?.[0].args).toEqual([
      '--teammate-mode',
      'auto',
      '--prompt',
      'space & caret ^ percent % bang !'
    ])
  })

  it('degrades an unsupported pane authority to in-process Claude', async () => {
    const shimDir = process.platform === 'win32' ? 'C:\\shim' : '/shim'
    const systemDir = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin'
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'
    const previousTmux = process.env.TMUX
    const previousTmuxPane = process.env.TMUX_PANE
    const previousShimDir = process.env.ORCA_AGENT_TEAMS_SHIM_DIR
    const previousPath = process.env.PATH
    process.env.TMUX = '/tmp/orca/team,0,1'
    process.env.TMUX_PANE = '%1'
    process.env.ORCA_AGENT_TEAMS_SHIM_DIR = shimDir
    process.env.PATH = `${shimDir}${pathDelimiter}${systemDir}`
    callMock.mockResolvedValueOnce({
      result: {
        launch: {
          mode: 'in-process',
          env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
        }
      }
    })
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs: ['--teammate-mode', 'auto', '--resume', 'session-1']
    }

    try {
      await CORE_HANDLERS['claude-teams'](ctx)
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      restore('TMUX', previousTmux)
      restore('TMUX_PANE', previousTmuxPane)
      restore('ORCA_AGENT_TEAMS_SHIM_DIR', previousShimDir)
      restore('PATH', previousPath)
    }

    expect(spawnMock.mock.calls.at(-1)?.[0]).toMatchObject({
      args: ['--teammate-mode', 'in-process', '--resume', 'session-1'],
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        TERM: 'xterm-256color'
      }
    })
    const spawnEnv = spawnMock.mock.calls.at(-1)?.[0].env as SpawnEnv
    expect(spawnEnv.TMUX).toBeUndefined()
    expect(spawnEnv.TMUX_PANE).toBeUndefined()
    expect(spawnEnv.PATH).toBe(systemDir)
  })

  it.skipIf(process.platform !== 'win32')(
    'fails closed when an older runtime omits mode and returns legacy native env',
    async () => {
      callMock.mockResolvedValueOnce({
        result: {
          launch: {
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              TMUX: '/tmp/orca/legacy,0,1',
              TMUX_PANE: '%1',
              ORCA_AGENT_TEAMS_TEAM_ID: 'legacy-team',
              ORCA_AGENT_TEAMS_TOKEN: 'legacy-token',
              ORCA_AGENT_TEAMS_SHIM_DIR: 'C:\\legacy-shim',
              PATH: 'C:\\legacy-shim;C:\\Windows\\System32'
            }
          }
        }
      })

      await runClaudeTeams()

      const spawnSpec = spawnMock.mock.calls.at(-1)?.[0]
      expect(spawnSpec.args).toEqual(['--teammate-mode', 'in-process'])
      expect(spawnSpec.env).toMatchObject({
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        PATH: 'C:\\Windows\\System32',
        TERM: 'xterm-256color'
      })
      expect(spawnSpec.env).not.toMatchObject({
        TMUX: expect.any(String),
        TMUX_PANE: expect.any(String),
        ORCA_AGENT_TEAMS_TEAM_ID: expect.any(String),
        ORCA_AGENT_TEAMS_TOKEN: expect.any(String),
        ORCA_AGENT_TEAMS_SHIM_DIR: expect.any(String)
      })
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'normalizes duplicate flags and mixed-case legacy native authority in-process',
    async () => {
      callMock.mockResolvedValueOnce({
        result: {
          launch: {
            mode: 'in-process',
            env: {
              tMuX: '/tmp/orca/legacy,0,1',
              oRcA_aGeNt_TeAmS_tOkEn: 'legacy-token',
              orca_agent_teams_shim_dir: 'c:\\legacy-shim',
              Path: 'C:\\LEGACY-SHIM\\;C:\\Windows\\System32'
            }
          }
        }
      })
      const ctx: HandlerContext = {
        flags: new Map(),
        client,
        cwd: 'C:\\repo',
        json: false,
        rawArgs: [
          '--teammate-mode',
          'auto',
          '--resume',
          'session-1',
          '--teammate-mode=in-process',
          '--teammate-mode',
          '--',
          '--teammate-mode',
          'auto'
        ]
      }

      await CORE_HANDLERS['claude-teams'](ctx)

      const spawnSpec = spawnMock.mock.calls.at(-1)?.[0]
      expect(spawnSpec.args).toEqual([
        '--teammate-mode',
        'in-process',
        '--resume',
        'session-1',
        '--',
        '--teammate-mode',
        'auto'
      ])
      expect(spawnSpec.env.Path).toBe('C:\\Windows\\System32')
      expect(Object.keys(spawnSpec.env).some((key) => key.toLowerCase() === 'tmux')).toBe(false)
      expect(
        Object.keys(spawnSpec.env).some((key) => key.toLowerCase() === 'orca_agent_teams_token')
      ).toBe(false)
    }
  )
})
