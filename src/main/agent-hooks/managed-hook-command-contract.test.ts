import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_HOOK_SETTINGS,
  OPENCLAUDE_HOOK_SETTINGS,
  getManagedLifecycleHook,
  getRemoteManagedCommand as getClaudeRemoteCommand
} from '../claude/hook-settings'
import {
  getManagedCommand as getCodexCommand,
  wrapReadablePosixHookCommand
} from '../codex/codex-hook-definition'
import { ANTIGRAVITY_EVENTS, ANTIGRAVITY_PRE_TOOL_USE_DECISION } from '../antigravity/hook-events'
import { getBobManagedCommand, getBobRemoteManagedCommand } from '../bob/hook-settings'
import { CURSOR_EVENTS } from '../cursor/hook-events'
import {
  getManagedCommand as getCursorCommand,
  getPosixManagedCommand as getCursorRemoteCommand
} from '../cursor/hook-script'
import {
  COPILOT_EVENTS,
  getManagedCommand as getCopilotCommand
} from '../copilot/copilot-managed-hook-definitions'
import { getDevinManagedCommand, getDevinRemoteManagedCommand } from '../devin/hook-settings'
import { getGrokManagedCommand } from '../grok/grok-hook-script'
import {
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  wrapWindowsHookCommand
} from './installer-utils'
import { MANAGED_AGENT_HOOK_INSTALLERS } from './managed-agent-hook-registry'
import { REMOTE_MANAGED_HOOK_INSTALLER_AGENTS } from './remote-managed-hook-installers'
import {
  findBareHookCommandVariables,
  GROK_PROVIDED_HOOK_VARIABLES
} from './managed-hook-command-env.test-fixture'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

afterEach(() => vi.restoreAllMocks())

type CommandBuilders = {
  local: (scriptPath: string) => string[]
  remote: (scriptPath: string) => string[]
}

// Why: Gemini/Droid/Command Code keep their thin builders private; exercise the wrappers they call.
const standardCommands: CommandBuilders = {
  local: (path) => [
    process.platform === 'win32' ? wrapWindowsHookCommand(path) : wrapPosixHookCommand(path)
  ],
  remote: (path) => [wrapPosixHookCommand(path)]
}

function antigravityPosixCommands(path: string): string[] {
  return ANTIGRAVITY_EVENTS.map((event) =>
    wrapPosixHookCommand(
      path,
      { ORCA_ANTIGRAVITY_EVENT: event.eventName },
      event.eventName === 'PreToolUse' ? { fallbackStdout: ANTIGRAVITY_PRE_TOOL_USE_DECISION } : {}
    )
  )
}

const buildersByAgent = new Map<string, CommandBuilders>([
  [
    'claude',
    {
      local: (path) =>
        [true, false].map(
          (gitBashAvailable) =>
            getManagedLifecycleHook(path, CLAUDE_HOOK_SETTINGS, { gitBashAvailable }).command
        ),
      remote: (path) => [getClaudeRemoteCommand(path)]
    }
  ],
  [
    'openclaude',
    {
      local: (path) => [getManagedLifecycleHook(path, OPENCLAUDE_HOOK_SETTINGS).command],
      remote: (path) => [getClaudeRemoteCommand(path)]
    }
  ],
  [
    'codex',
    {
      local: (path) => [getCodexCommand(path), wrapReadablePosixHookCommand(path)],
      remote: (path) => [wrapPosixHookCommand(path), wrapReadablePosixHookCommand(path)]
    }
  ],
  ['gemini', standardCommands],
  [
    'antigravity',
    {
      local: (path) =>
        process.platform === 'win32'
          ? ANTIGRAVITY_EVENTS.map((event) =>
              wrapWindowsCmdHookCommand(
                path.replace('antigravity-hook.cmd', event.windowsWrapperFileName)
              )
            )
          : antigravityPosixCommands(path),
      remote: antigravityPosixCommands
    }
  ],
  [
    'cursor',
    {
      local: (path) => CURSOR_EVENTS.map((event) => getCursorCommand(path, event)),
      remote: (path) => CURSOR_EVENTS.map((event) => getCursorRemoteCommand(path, event))
    }
  ],
  ['droid', standardCommands],
  ['command-code', standardCommands],
  [
    'grok',
    {
      local: (path) => [getGrokManagedCommand(path)],
      // Why: grok-hook-remote-install.ts calls this wrapper directly, with the pane guard.
      remote: (path) => [wrapPosixHookCommand(path, {}, { requiredEnvVar: 'ORCA_PANE_KEY' })]
    }
  ],
  [
    'copilot',
    {
      local: (path) => COPILOT_EVENTS.map((event) => getCopilotCommand(path, event)),
      remote: (path) =>
        COPILOT_EVENTS.map((event) =>
          wrapPosixHookCommand(path, { ORCA_COPILOT_HOOK_EVENT: event })
        )
    }
  ],
  [
    'devin',
    {
      local: (path) => [getDevinManagedCommand(path)],
      remote: (path) => [getDevinRemoteManagedCommand(path)]
    }
  ],
  [
    'kimi',
    {
      local: (path) => [wrapPosixHookCommand(path.replaceAll('\\', '/'))],
      remote: (path) => [wrapPosixHookCommand(path)]
    }
  ],
  [
    'bob',
    {
      local: (path) => [getBobManagedCommand(path)],
      remote: (path) => [getBobRemoteManagedCommand(path)]
    }
  ]
])

// Why: as in MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS, native plugin source has no shell command to scan.
const exemptionsByAgent = new Map([
  ['amp', 'Native TypeScript plugin source; no shell hook command'],
  ['hermes', 'Native Python plugin source; no shell hook command']
])

describe('managed hook command contract', () => {
  it.each([
    ['local', MANAGED_AGENT_HOOK_INSTALLERS.map(([agent]) => agent)],
    ['remote', REMOTE_MANAGED_HOOK_INSTALLER_AGENTS]
  ] as const)('covers the %s installer registry in both directions', (_target, agents) => {
    // Why: mirror the remote installer coverage ratchet (#7253); a new provider cannot opt out silently.
    for (const agent of agents) {
      expect(
        Number(buildersByAgent.has(agent)) + Number(exemptionsByAgent.has(agent)),
        `${agent} needs exactly one command builder or documented native-plugin exemption`
      ).toBe(1)
    }
    const registered = new Set<string>(agents)
    for (const agent of [...buildersByAgent.keys(), ...exemptionsByAgent.keys()]) {
      expect(registered.has(agent), `${agent} is absent from the installer registry`).toBe(true)
    }
  })

  describe.each(['darwin', 'linux', 'win32'] as const)('%s host', (platform) => {
    it.each([...buildersByAgent])('%s emits no bare variable references', (agent, builders) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const extension = platform === 'win32' && agent !== 'kimi' ? 'cmd' : 'sh'
      const homes =
        platform === 'win32' ? ['C:/Users/test', 'C:/Users/test user'] : ['/home/test user']
      const paths = homes.map((home) => `${home}/.orca/agent-hooks/${agent}-hook.${extension}`)
      const commands = [
        ...paths.flatMap((path) => builders.local(path)),
        ...builders.remote(`/home/remote user/.orca/agent-hooks/${agent}-hook.sh`)
      ]
      expect(commands.length).toBeGreaterThan(0)
      for (const command of commands) {
        expect(command.length).toBeGreaterThan(0)
        expect(findBareHookCommandVariables(command), command).toEqual([])
      }
    })
  })
})

describe('Grok variable scanner contract', () => {
  it.each(['$NAME', '${NAME}', "'$NAME'", "'${NAME}'", '\\$NAME', '$lower_9', '${_NAME9}'])(
    'rejects bare references without shell quoting state: %s',
    (command) => expect(findBareHookCommandVariables(command)).toHaveLength(1)
  )

  it.each([
    '${NAME-}',
    '${NAME:-}',
    '${NAME:+}',
    '${NAME#x}',
    '${NAME:0:5}',
    '${NAME+x}',
    '${NAME=x}',
    '${NAME?x}',
    '${NAME%x}',
    '${NAME/x/y}',
    '$1',
    '$$',
    '$?',
    '$(true)'
  ])('allows modifiers and non-variable dollar forms: %s', (command) => {
    expect(findBareHookCommandVariables(command)).toEqual([])
  })

  it.each(GROK_PROVIDED_HOOK_VARIABLES)('exempts only the exact provided name %s', (name) => {
    expect(findBareHookCommandVariables(`$${name} \${${name}}`)).toEqual([])
    expect(findBareHookCommandVariables(`$${name}_OTHER \${${name}_OTHER}`)).toHaveLength(2)
  })
})
