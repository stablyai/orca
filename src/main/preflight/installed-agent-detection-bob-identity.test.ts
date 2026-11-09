import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findCommandsOnLocalPathMock, resolveCommandOnLocalPathMock, resolveCliCommandsMock } =
  vi.hoisted(() => ({
    findCommandsOnLocalPathMock: vi.fn(),
    resolveCommandOnLocalPathMock: vi.fn(),
    resolveCliCommandsMock: vi.fn()
  }))
const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: vi.fn()
}))
vi.mock('../ipc/command-path/command-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findCommandsOnLocalPath: findCommandsOnLocalPathMock,
  resolveCommandOnLocalPath: resolveCommandOnLocalPathMock
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommands: resolveCliCommandsMock
}))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: runProcessMock
}))

import { detectInstalledAgents } from './installed-agent-detection'
import { clearIdentityProbeCache } from './preflight-identity-probe'

// Verbatim `bob --help` stdout from bobshell 2.0.6 (commit 88346061a), under an English locale.
const BOB_SHELL_2_0_6_HELP =
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
  '  -h, --help                 Display help for command\n' +
  '\n' +
  'Commands:\n' +
  '  chat [options]             Launch the interactive terminal UI client\n' +
  '  run [options] [prompt...]  Execute a single task in headless mode\n' +
  '  mcp [options]              Manage MCP server configurations\n' +
  '  acp [options]              Start Bob Shell as an Agent Client Protocol server\n'

const BOB_PATH = '/home/test/.local/bin/bob'

function pathFinds(found: Record<string, string>): void {
  findCommandsOnLocalPathMock.mockImplementation(
    async (commands: readonly string[]) => new Set(commands.filter((command) => command in found))
  )
  resolveCommandOnLocalPathMock.mockImplementation(
    async (command: string) => found[command] ?? null
  )
}

function bobHelpPrints(stdout: string, code = 0): void {
  runProcessMock.mockResolvedValue({
    code,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    outputTruncated: false
  })
}

describe('detectInstalledAgents IBM Bob identity', () => {
  beforeEach(() => {
    clearIdentityProbeCache()
    runProcessMock.mockReset()
    // Install-dir fallback finds nothing unless a case opts in.
    resolveCliCommandsMock.mockReset()
    resolveCliCommandsMock.mockImplementation(
      (commands: string[]) => new Map(commands.map((command) => [command, command]))
    )
  })

  it('detects IBM Bob by probing the executable detection resolved', async () => {
    pathFinds({ bob: BOB_PATH })
    bobHelpPrints(BOB_SHELL_2_0_6_HELP)

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: BOB_PATH, args: ['--help'] })
  })

  it('excludes the Neovim version manager when it owns the bob executable', async () => {
    pathFinds({ bob: '/home/test/.cargo/bin/bob' })
    bobHelpPrints('bob 4.0.3\nA version manager for Neovim\n')

    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: '/home/test/.cargo/bin/bob' })
  })

  it('keeps IBM Bob when the identity probe cannot start', async () => {
    // A probe that errors says nothing about identity, so it must not hide a real install.
    pathFinds({ bob: BOB_PATH })
    runProcessMock.mockRejectedValue(new Error('probe unavailable'))

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
  })

  it('keeps IBM Bob when the identity probe exits non-zero', async () => {
    pathFinds({ bob: BOB_PATH })
    bobHelpPrints('A version manager for Neovim\n', 1)

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
  })

  it('excludes an unrelated bob executable whose help carries no Bob Shell signature', async () => {
    // The exclusion is otherwise fail-open, so any stray `bob` script would pass as IBM Bob.
    pathFinds({ bob: BOB_PATH })
    bobHelpPrints('usage: bob <target>\nProject build runner\n')

    await expect(detectInstalledAgents()).resolves.toEqual([])
  })

  it('probes the install-dir executable when bob is absent from PATH', async () => {
    // A cold GUI launch finds CLIs in install dirs before PATH hydrates; a bare-name probe would ENOENT.
    pathFinds({})
    resolveCliCommandsMock.mockImplementation(
      (commands: string[]) =>
        new Map(commands.map((command) => [command, command === 'bob' ? BOB_PATH : command]))
    )
    bobHelpPrints('A version manager for Neovim\n')

    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: BOB_PATH })
  })

  it('trusts a found command override instead of probing the bare PATH hit', async () => {
    pathFinds({ bob: '/home/test/.cargo/bin/bob', '/opt/ibm/bob': '/opt/ibm/bob' })
    bobHelpPrints('A version manager for Neovim\n')

    await expect(
      detectInstalledAgents(undefined, { agentCmdOverrides: { bob: '/opt/ibm/bob' } })
    ).resolves.toEqual(['bob'])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('reuses the identity probe for the same executable across detections', async () => {
    pathFinds({ bob: BOB_PATH })
    bobHelpPrints(BOB_SHELL_2_0_6_HELP)

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a failed identity probe', async () => {
    pathFinds({ bob: BOB_PATH })
    runProcessMock.mockRejectedValueOnce(new Error('probe unavailable'))

    await expect(detectInstalledAgents()).resolves.toEqual(['bob'])
    bobHelpPrints('A version manager for Neovim\n')
    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })
})
