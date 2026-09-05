import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  execFileMock,
  execFileAsyncMock,
  hydrateShellPathMock,
  mergePathSegmentsMock,
  getActiveMultiplexerMock,
  getBitbucketAuthStatusMock,
  getAzureDevOpsAuthStatusMock,
  getGiteaAuthStatusMock,
  resolveCliCommandsMock,
  isCommandOnLocalPathMock,
  resolveCommandOnLocalPathMock,
  mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  hydrateShellPathMock: vi.fn(),
  mergePathSegmentsMock: vi.fn(),
  getActiveMultiplexerMock: vi.fn(),
  getBitbucketAuthStatusMock: vi.fn(),
  getAzureDevOpsAuthStatusMock: vi.fn(),
  getGiteaAuthStatusMock: vi.fn(),
  resolveCliCommandsMock: vi.fn(),
  isCommandOnLocalPathMock: vi.fn(),
  resolveCommandOnLocalPathMock: vi.fn(),
  mergePersistedWindowsPathAsyncMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

const runWslProcessMock = vi.hoisted(() => vi.fn())
// Why the runner and not child_process: WSL agent detection goes through
// runWslProcess now, so a child_process mock never sees it.
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

const runProcessMock = vi.hoisted(() => vi.fn())
// Why: the identity probe starts the resolved executable through runProcess
// (so Windows `.cmd` shims work), which the child_process mock never sees.
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return {
    execFile: execFileWithPromisify,
    spawn: vi.fn()
  }
})

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock,
  mergePathSegments: mergePathSegmentsMock
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommands: resolveCliCommandsMock
}))

// Why (#9297): local PATH resolution is now fs-based (no where/which spawn).
// These tests express "which commands are on PATH" via the where/which mock,
// so route the resolver through that same mock to preserve their intent.
vi.mock('./command-path-resolver', () => ({
  isCommandOnLocalPath: isCommandOnLocalPathMock,
  resolveCommandOnLocalPath: resolveCommandOnLocalPathMock
}))

vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPath: mergePersistedWindowsPathMock
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketAuthStatus: getBitbucketAuthStatusMock
}))

vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsAuthStatus: getAzureDevOpsAuthStatusMock
}))

vi.mock('../gitea/client', () => ({
  getGiteaAuthStatus: getGiteaAuthStatusMock
}))

import {
  detectInstalledAgents,
  detectInstalledAgentsWithShellPathHydration,
  registerPreflightHandlers
} from './preflight'
import { resetPreflightMocks, type HandlerMap } from './preflight-test-harness'

// Verbatim `bob --help` stdout from bobshell 2.0.1 (commit e6a3e508).
const BOB_SHELL_2_0_1_HELP =
  'Usage: bob [options] [command]\n' +
  '\n' +
  'Bob in your terminal\n' +
  '\n' +
  'Options:\n' +
  '  -v, --version              Show current version number\n' +
  '  -p, --prompt <prompt>      Prompt to send to the agent\n' +
  '  -r, --resume [task-id]     Open the resume picker, or resume a specific task\n' +
  '                             id\n' +
  "  --list-tasks [limit]       List available tasks (optional: number or 'all',\n" +
  '                             default 20)\n' +
  '  --show-license             Show full paths to license files for review\n' +
  '  --accept-license           Accept the IBM license agreement and continue\n' +
  '  -h, --help                 display help for command\n' +
  '\n' +
  'Commands:\n' +
  '  chat [options]             Launch the interactive terminal UI client\n' +
  '  run [options] [prompt...]  Execute a single task in headless mode\n' +
  '  mcp                        Manage MCP server configurations\n'

describe('preflight', () => {
  const originalPlatform = process.platform
  const handlers: HandlerMap = {}

  beforeEach(() => {
    runWslProcessMock.mockReset()
    runProcessMock.mockReset()
    resetPreflightMocks(
      {
        handleMock,
        execFileAsyncMock,
        hydrateShellPathMock,
        mergePathSegmentsMock,
        getActiveMultiplexerMock,
        getBitbucketAuthStatusMock,
        getAzureDevOpsAuthStatusMock,
        getGiteaAuthStatusMock,
        resolveCliCommandsMock,
        isCommandOnLocalPathMock,
        resolveCommandOnLocalPathMock,
        mergePersistedWindowsPathAsyncMock,
        mergePersistedWindowsPathMock
      },
      handlers
    )
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  it('only reports agents when which/where resolves to a real executable path', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }

      const target = String(args[0])
      if (target === 'claude') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      if (target === 'continue') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: 'continue: shell built-in command\n',
          stderr: '',
          timedOut: false
        }
      }
      if (target === 'cursor-agent') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/cursor-agent\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['claude', 'cursor'])
  })

  it('does not report Claude Agent Teams when only the Orca shim is present', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'orca') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Applications/Orca.app/Contents/MacOS/orca\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual([])
  })

  it('reports Claude Agent Teams when both Orca and Claude are present', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'claude') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      if (String(args[0]) === 'orca') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Applications/Orca.app/Contents/MacOS/orca\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['claude', 'claude-agent-teams'])
  })

  it('does not report Claude Agent Teams on native Windows', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'where') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'claude') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/mock/windows/npm/claude.cmd\n',
          stderr: '',
          timedOut: false
        }
      }
      if (String(args[0]) === 'orca') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/mock/windows/programs/orca.cmd\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['claude'])
  })

  it('detects agents via the install-dir resolver when which fails (stripped GUI PATH)', async () => {
    // Why: cold GUI launches can run detection before shell-PATH hydration
    // adds user install dirs, so `which` can miss runnable CLIs.
    execFileAsyncMock.mockImplementation(async (command) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      throw new Error('not found')
    })
    resolveCliCommandsMock.mockImplementation(
      (commands: string[]) =>
        new Map(
          commands.map((cmd) => {
            if (cmd === 'claude') {
              return [cmd, '/Users/test/.local/bin/claude']
            }
            if (cmd === 'codex') {
              return [cmd, '/Users/test/.asdf/shims/codex']
            }
            if (cmd === 'opencode') {
              return [cmd, '/Users/test/Library/pnpm/opencode']
            }
            return [cmd, cmd]
          })
        )
    )

    await expect(detectInstalledAgents()).resolves.toEqual(['claude', 'codex', 'opencode'])
    expect(resolveCliCommandsMock).toHaveBeenCalledTimes(1)
  })

  it('does not double-count an agent already found on PATH via the install-dir resolver', async () => {
    // Why: the fallback should not duplicate ids when PATH already finds a CLI.
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'claude') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })
    resolveCliCommandsMock.mockImplementation(
      (commands: string[]) => new Map(commands.map((cmd) => [cmd, cmd]))
    )

    await expect(detectInstalledAgents()).resolves.toEqual(['claude'])
    expect(resolveCliCommandsMock).toHaveBeenCalledTimes(1)
    expect(resolveCliCommandsMock).toHaveBeenCalledWith(expect.not.arrayContaining(['claude']))
  })

  it('treats an agent as not installed when the install-dir resolver throws', async () => {
    // Why: transient fs errors in the fallback must not crash detection.
    execFileAsyncMock.mockImplementation(async (command) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      throw new Error('not found')
    })
    resolveCliCommandsMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    await expect(detectInstalledAgents()).resolves.toEqual([])
  })

  it('registers agent detection through the shared launch config commands', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'openclaude') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/openclaude\n',
          stderr: '',
          timedOut: false
        }
      }
      if (String(args[0]) === 'cursor-agent') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/cursor-agent\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    registerPreflightHandlers()

    await expect(handlers['preflight:detectAgents']()).resolves.toEqual(['openclaude', 'cursor'])
  })

  it('hydrates shell PATH before user-facing agent detection', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/usr/bin'
    hydrateShellPathMock.mockResolvedValueOnce({
      segments: ['/home/test/.local/bin'],
      ok: true,
      failureReason: 'none'
    })
    mergePathSegmentsMock.mockImplementationOnce((segments: string[]) => {
      process.env.PATH = [...segments, '/usr/bin'].join(':')
      return segments
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'codex' && process.env.PATH?.startsWith('/home/test/.local/bin')) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/home/test/.local/bin/codex\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    try {
      await expect(detectInstalledAgentsWithShellPathHydration()).resolves.toEqual(['codex'])
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
    expect(hydrateShellPathMock).toHaveBeenCalledWith()
    expect(mergePathSegmentsMock).toHaveBeenCalledWith(['/home/test/.local/bin'])
  })

  it('does not run host shell hydration for WSL agent detection', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      if (script.includes("'claude'")) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '__ORCA_AGENT_PATH__claude\t/home/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(
      detectInstalledAgentsWithShellPathHydration({ wslDistro: 'Ubuntu' })
    ).resolves.toEqual(['claude'])
    expect(hydrateShellPathMock).not.toHaveBeenCalled()
  })

  it('does not report Claude Agent Teams from WSL agent detection', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      expect(script).not.toContain("'orca'")
      expect(script).not.toContain("'orca-dev'")
      expect(script).not.toContain("'orca-ide'")
      if (script.includes("'claude'")) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '__ORCA_AGENT_PATH__claude\t/home/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents({ wslDistro: 'Ubuntu' })).resolves.toEqual(['claude'])
  })

  it('detects Mistral Vibe from the installed vibe executable', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'vibe') {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/home/test/.local/bin/vibe\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['mistral-vibe'])
  })

  const BOB_PATH = '/home/test/.local/bin/bob'

  function whichFinds(paths: Record<string, string>): void {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      const found = paths[String(args[0])]
      if (found) {
        return { stdout: `${found}\n` }
      }
      throw new Error('not found')
    })
  }

  function bobHelpPrints(stdout: string, code = 0): void {
    runProcessMock.mockImplementation(
      async (spec: { program: string; args: readonly string[] }) => {
        if (spec.program === BOB_PATH && spec.args[0] === '--help') {
          return { code, signal: null, stdout, stderr: '', timedOut: false }
        }
        throw new Error(`unexpected program ${spec.program}`)
      }
    )
  }

  it('detects IBM Bob by probing the executable detection resolved', async () => {
    whichFinds({ bob: BOB_PATH })
    bobHelpPrints(BOB_SHELL_2_0_1_HELP)

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: BOB_PATH, args: ['--help'] })
  })

  it('excludes the Neovim version manager when it owns the bob executable', async () => {
    whichFinds({ bob: '/home/test/.cargo/bin/bob' })
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'bob 4.0.3\nA version manager for Neovim\n',
      stderr: '',
      timedOut: false
    })

    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: '/home/test/.cargo/bin/bob' })
  })

  it('keeps IBM Bob when the identity probe cannot start', async () => {
    // Why: a probe that errors says nothing about identity, so it must not hide a real install.
    whichFinds({ bob: BOB_PATH })
    runProcessMock.mockRejectedValue(new Error('probe unavailable'))

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
  })

  it('keeps IBM Bob when the identity probe exits non-zero', async () => {
    whichFinds({ bob: BOB_PATH })
    bobHelpPrints('A version manager for Neovim\n', 1)

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
  })

  it('keeps IBM Bob when its own help text is returned', async () => {
    whichFinds({ bob: BOB_PATH })
    bobHelpPrints(
      'Usage: bob [options] [command]\n\nBob in your terminal\n\n  --accept-license  Accept the IBM license agreement and continue\n'
    )

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
  })

  it('excludes an unrelated bob executable whose help carries no Bob Shell signature', async () => {
    // Why: the exclusion is otherwise fail-open, so any stray `bob` script would pass as IBM Bob.
    whichFinds({ bob: BOB_PATH })
    bobHelpPrints('usage: bob <target>\nProject build runner\n')

    await expect(detectInstalledAgents()).resolves.toEqual([])
  })

  it('probes the install-dir executable when bob is absent from PATH', async () => {
    // Why: a cold GUI launch finds CLIs in user install dirs before PATH is
    // hydrated; probing the bare name there would ENOENT and fail open.
    whichFinds({})
    resolveCliCommandsMock.mockImplementation(
      (commands: string[]) =>
        new Map(commands.map((command) => [command, command === 'bob' ? BOB_PATH : command]))
    )
    bobHelpPrints('A version manager for Neovim\n')

    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: BOB_PATH })
  })

  it('reuses the identity probe for the same executable across detections', async () => {
    whichFinds({ bob: BOB_PATH })
    bobHelpPrints(BOB_SHELL_2_0_1_HELP)

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a failed identity probe', async () => {
    whichFinds({ bob: BOB_PATH })
    runProcessMock.mockRejectedValueOnce(new Error('probe unavailable'))

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    bobHelpPrints('A version manager for Neovim\n')
    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates Mistral Vibe when both current and legacy executables exist', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'vibe' || String(args[0]) === 'mistral-vibe') {
        return { stdout: `/home/test/.local/bin/${String(args[0])}\n` }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['mistral-vibe'])
  })

  it('detects agents from the selected WSL distro for a WSL workspace', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      if (script.includes("'claude'")) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '__ORCA_AGENT_PATH__claude\t/home/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents({ wslDistro: 'Ubuntu' })).resolves.toEqual(['claude'])
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    // Why: the local fallback must not report host binaries as WSL binaries.
    expect(resolveCliCommandsMock).not.toHaveBeenCalled()
    // Why assert the lane, not the argv: argv is the runner's contract and is
    // pinned by its own tests. What this suite owns is that detection asks the
    // right distro on the lane that carries the user's PATH.
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ distro: 'Ubuntu', loginPath: 'preferred' })
    )
  })

  it('detects agents from the default WSL distro when requested', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      if (script.includes("'codex'")) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '__ORCA_AGENT_PATH__codex\t/home/test/.local/bin/codex\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents({ wslDefault: true })).resolves.toEqual(['codex'])
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    // Why: the local fallback must not leak into WSL detection.
    expect(resolveCliCommandsMock).not.toHaveBeenCalled()
    // No distro named: the runner resolves the default.
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ distro: undefined, loginPath: 'preferred' })
    )
  })
})
