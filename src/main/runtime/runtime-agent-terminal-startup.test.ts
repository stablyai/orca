import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ZcodeCliInvocation from '../zcode/zcode-cli-invocation'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'

const resolveZcodeCliInvocationMock = vi.hoisted(() => vi.fn())

vi.mock('../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qoder']))
}))
vi.mock('../zcode/zcode-cli-invocation', async (importOriginal) => ({
  ...(await importOriginal<typeof ZcodeCliInvocation>()),
  resolveZcodeCliInvocation: resolveZcodeCliInvocationMock
}))

const workspace = { id: 'w', path: '/repo', connectionId: null, repo: null, folderWorkspace: null }
const host = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: for a workspace with no repo or folder, the planner reads only getSettings.
  store: { getSettings: () => ({ terminalWindowsShell: 'cmd.exe' }) } as never,
  hostIdentity: 'host-1',
  toSessionOptions: () => undefined
}
const original = process.platform
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { configurable: true, value })
beforeEach(() => {
  setPlatform('win32')
  resolveZcodeCliInvocationMock.mockReset()
})
afterEach(() => {
  setPlatform(original)
  _resetWslCachesForTests()
})

// The host planner's inputs. Relied on by C2, whose pane spawns run this plan.
describe('host agent planner', () => {
  it('refuses a Desktop bundle as a terminal agent', async () => {
    resolveZcodeCliInvocationMock.mockReturnValue({
      command: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      prefixArgs: ['C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'],
      envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
      identity: 'desktop',
      source: 'desktop-bundle'
    })

    await expect(
      resolveAgentTerminalCreateOptions(
        workspace,
        {
          startupAgent: 'zcode',
          launchRuntime: {
            platform: 'win32',
            pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
          }
        },
        host
      )
    ).rejects.toThrow('ZCode Desktop does not include the terminal TUI')
    expect(resolveZcodeCliInvocationMock).toHaveBeenCalledOnce()
  })

  it("quotes for the fact's shell and hands that same fact to the spawn", async () => {
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      { startupAgent: 'claude', agentArgs: '--model opus' },
      host
    )
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.launchRuntime).toEqual({
      platform: 'win32',
      pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
    })
  })

  // As on main: a disabled agent is refused as disabled, before its runtime is looked at.
  it('refuses a disabled agent before a runtime that needs repair', async () => {
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    const repo = { id: 'r', path: 'C:\\r' }
    const preference = { kind: 'wsl', distro: 'Ubuntu' }
    const store = {
      getSettings: () => ({ disabledTuiAgents: ['claude'] }),
      getProjects: () => [
        { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: preference }
      ],
      getRepo: () => repo
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these members and fields.
    const scope = { ...workspace, id: 'r', path: repo.path, repo } as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const planHost = { ...host, store: store as never }
    const plan = resolveAgentTerminalCreateOptions(scope, { startupAgent: 'claude' }, planHost)
    await expect(plan).rejects.toThrow('Agent claude is disabled')
  })

  it("rewrites Qoder once, probing where the fact's PTY runs (C2 skips the window copy)", async () => {
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'qoder',
        agentArgs: null,
        launchRuntime: {
          platform: 'linux',
          pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
        }
      },
      host
    )
    expect(launch.command).toBe('qoder')
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
  })

  // A `\\wsl$` cwd runs in WSL whatever the project says, so a WSL shell is what this agent gets.
  it('applies --shell wsl.exe for an agent in a WSL-share repo set to Windows host', async () => {
    const repo = { id: 'r', path: '\\\\wsl$\\Ubuntu\\r' }
    const preference = { kind: 'windows-host' }
    const store = {
      getSettings: () => ({ terminalWindowsShell: 'cmd.exe' }),
      getProjects: () => [
        { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: preference }
      ],
      getRepo: () => repo
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these members and fields.
    const share = { ...workspace, id: 'r', path: repo.path, repo } as never
    const opts = { startupAgent: 'claude', shellOverride: 'wsl.exe' } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const planHost = { ...host, store: store as never }
    const launch = await resolveAgentTerminalCreateOptions(share, opts, planHost)
    expect(launch.launchRuntime?.pty.shellOverride).toBe('wsl.exe')
  })
})
