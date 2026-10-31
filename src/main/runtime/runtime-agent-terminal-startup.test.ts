import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'
import { MIXED_FOLDER, MIXED_GROUP } from '../../shared/folder-workspace-host-routing.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import type { SessionOptionValue } from '../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import { getDefaultWorkspaceSession } from '../../shared/constants'

vi.mock('../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qoder']))
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
beforeEach(() => setPlatform('win32'))
afterEach(() => {
  setPlatform(original)
  _resetWslCachesForTests()
})

// The host planner's inputs. Relied on by C2, whose pane spawns run this plan.
describe('host agent planner', () => {
  it('uses the acquired folder project for plain shell refusal and unplanned Qoder detection', async () => {
    const folder = { ...MIXED_FOLDER, folderPath: 'C:/notes', executionHostId: 'local' as const }
    const repo = {
      id: 'r',
      path: 'C:/repo',
      projectGroupId: MIXED_GROUP.id,
      executionHostId: 'local' as const
    }
    const session = getDefaultWorkspaceSession()
    const store = {
      getSettings: () => ({ terminalWindowsShell: 'powershell.exe' }),
      getProjects: () => [
        {
          id: 'p',
          sourceRepoIds: ['r'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      getRepos: () => [{ ...repo, executionHostId: 'ssh:prod' }, repo],
      getFolderWorkspaces: () => [{ ...folder, executionHostId: 'ssh:prod' }, folder],
      getProjectGroups: () => [MIXED_GROUP],
      getWorkspaceSession: () => session
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actual planner consumes these runtime store ports and the supplied full physical folder.
    const planHost = { ...host, store: store as never }
    const scope = {
      ...workspace,
      id: `folder:${folder.id}`,
      path: folder.folderPath,
      folderWorkspace: folder
    }
    await expect(
      resolveAgentTerminalCreateOptions(scope, { shellOverride: 'powershell.exe' }, planHost)
    ).rejects.toThrow('project runs its terminals in WSL')
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    await resolveAgentTerminalCreateOptions(
      scope,
      { launchAgent: 'qoder', command: 'qodercli' },
      planHost
    )
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
    session.tabsByWorktree[scope.id] = [
      {
        id: 'saved-host',
        worktreeId: scope.id,
        ptyId: null,
        title: 'Shell',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0,
        forceHostRuntime: true
      }
    ]
    await expect(
      resolveAgentTerminalCreateOptions(
        scope,
        { tabId: 'saved-host', shellOverride: 'powershell.exe' },
        planHost
      )
    ).resolves.toMatchObject({ shellOverride: 'powershell.exe' })
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

it.each([
  {
    name: 'absent Args',
    agent: 'claude',
    options: {
      model: 'private/sonnet',
      effort: 'high',
      fastMode: 'true',
      permissionMode: 'accept-edits'
    },
    expected: [
      '--verbose',
      '--model',
      'private/sonnet',
      '--effort',
      'high',
      '--settings',
      '{"fastMode":true}',
      '--permission-mode',
      'acceptEdits'
    ]
  },
  {
    name: 'null Args',
    agent: 'claude',
    args: null,
    options: { model: 'private/sonnet', fastMode: 'true' },
    expected: ['--model', 'private/sonnet', '--settings', '{"fastMode":true}']
  },
  {
    name: 'empty Args and explicit off',
    agent: 'claude',
    args: '',
    options: { model: 'private/sonnet', fastMode: 'false' },
    expected: ['--model', 'private/sonnet', '--settings', '{"fastMode":false}']
  },
  {
    name: 'original bytes and Settings siblings',
    agent: 'claude',
    args: `  --settings '{"theme":"dark","sibling":7}'  --debug  `,
    options: { model: 'private/sonnet', fastMode: 'true' },
    expected: [
      '--settings',
      '{"theme":"dark","sibling":7,"fastMode":true}',
      '--debug',
      '--model',
      'private/sonnet'
    ]
  },
  {
    name: 'declared independent Codex Speed',
    agent: 'codex',
    args: '--verbose',
    options: { model: 'gpt-5.5', effort: 'high', serviceTier: 'priority', permissionMode: 'ask' },
    expected: [
      '-c',
      'disable_paste_burst=true',
      '--verbose',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=high',
      '-c',
      'service_tier=priority',
      '-a',
      'on-request',
      '-s',
      'read-only',
      '-c',
      'approvals_reviewer=user'
    ]
  },
  {
    name: 'composed Cursor domain',
    agent: 'cursor',
    args: '--verbose',
    options: { model: 'claude-opus-4-8', thinking: 'true', effort: 'high' },
    expected: ['--verbose', '--model', 'claude-opus-4-8-thinking-high']
  }
] satisfies {
  name: string
  agent: TuiAgent
  args?: string | null
  options: Record<string, SessionOptionValue>
  expected: string[]
}[])('delivers $name through the existing host planner and final compiler', async (fixture) => {
  setPlatform('linux')
  const settings = {
    agentDefaultArgs: { claude: '--verbose' },
    agentDefaultEnv: { claude: { CUSTOM_ENV: 'kept' } },
    agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'low', fastMode: 'true' } } },
    agentPermissionDefault: 'own' as const
  }
  const fullHost = { ...host, store: partialRuntimeStore({ getSettings: () => settings }) }
  const opts = {
    startupAgent: fixture.agent,
    ...('args' in fixture ? { agentArgs: fixture.args } : {})
  }
  const result = await resolveAgentTerminalCreateOptions(workspace, opts, fullHost, fixture.options)
  const parsed = tokenizeStartupCommand(result.command ?? '', 'posix')
  expect(parsed.ok && parsed.tokens).toEqual([
    fixture.agent === 'cursor' ? 'cursor-agent' : fixture.agent,
    ...fixture.expected
  ])
  const oracle = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: fixture.agent,
      settings,
      platform: 'linux',
      isRemote: false,
      shell: 'posix',
      ...('args' in fixture ? { agentArgs: fixture.args } : {}),
      sessionOptions: fixture.options
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  expect(result.command).toBe(oracle?.launchCommand)
  expect(result.launchConfig).toEqual(oracle?.launchConfig)
  expect(result.launchConfig?.agentArgs).toBe(oracle?.launchConfig.agentArgs)
  if (fixture.agent === 'claude') {
    expect(result.env).toMatchObject({ CUSTOM_ENV: 'kept' })
  }
})
