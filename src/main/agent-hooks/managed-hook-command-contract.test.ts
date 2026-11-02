import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_HOOK_SETTINGS,
  OPENCLAUDE_HOOK_SETTINGS,
  getManagedEventHook,
  getManagedLifecycleHook,
  getRemoteManagedCommand as getClaudeRemoteCommand,
  getRemoteManagedEventCommand
} from '../claude/hook-settings'
import {
  getManagedCommand as getCodexCommand,
  wrapReadablePosixHookCommand
} from '../codex/codex-hook-definition'
import { ANTIGRAVITY_EVENTS, ANTIGRAVITY_PRE_TOOL_USE_DECISION } from '../antigravity/hook-events'
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
import { getMuseManagedCommand, getMuseRemoteManagedCommand } from '../muse/hook-settings'
import { getDshManagedCommand, getDshRemoteManagedCommand } from '../dsh/hook-settings'
import { getZCodeManagedCommand, getZCodeRemoteManagedCommand } from '../zcode/hook-settings'
import { getJcodeManagedCommand, getJcodeRemoteManagedCommand } from '../jcode/hook-settings'
import { getKiroManagedCommand, getKiroRemoteManagedCommand } from '../kiro/hook-settings'
import { wrapPosixHookCommand } from './installer-utils'
import { getManagedCommand as getKimiManagedCommand } from '../kimi/hook-service'
import { wrapWindowsBatchHookCommand } from './windows-direct-cmd-hook-command'
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

// Private Gemini/Droid/Command Code builders delegate to these wrappers.
const standardCommands: CommandBuilders = {
  local: (path) => [
    process.platform === 'win32' ? wrapWindowsBatchHookCommand(path) : wrapPosixHookCommand(path)
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

function claudeFamilyBuilders(settings: typeof CLAUDE_HOOK_SETTINGS): CommandBuilders {
  return {
    local: (path) => [
      getManagedLifecycleHook(path, settings).command,
      getManagedEventHook('PostCompact', path, settings).command
    ],
    remote: (path) => [
      getClaudeRemoteCommand(path),
      getRemoteManagedEventCommand('PostCompact', path)
    ]
  }
}

const buildersByAgent = new Map<string, CommandBuilders>([
  ['claude', claudeFamilyBuilders(CLAUDE_HOOK_SETTINGS)],
  ['openclaude', claudeFamilyBuilders(OPENCLAUDE_HOOK_SETTINGS)],
  [
    'qoder',
    {
      local: (path) => [
        getManagedLifecycleHook(path, {
          configDirName: '.qoder',
          scriptBaseName: 'qoder-hook',
          usesWindowsCompatLauncher: true,
          windowsHookShell: 'powershell'
        }).command
      ],
      remote: (path) => [getClaudeRemoteCommand(path)]
    }
  ],
  [
    'qoder-cn',
    {
      local: (path) => [
        getManagedLifecycleHook(path, {
          configDirName: '.qoder-cn',
          scriptBaseName: 'qoder-cn-hook',
          usesWindowsCompatLauncher: true,
          windowsHookShell: 'powershell'
        }).command
      ],
      remote: (path) => [getClaudeRemoteCommand(path)]
    }
  ],
  [
    'qwen-code',
    {
      local: (path) => [
        getManagedLifecycleHook(path, {
          configDirName: '.qwen',
          scriptBaseName: 'qwen-code-hook',
          usesWindowsCompatLauncher: true,
          windowsHookShell: 'powershell'
        }).command
      ],
      remote: (path) => [getClaudeRemoteCommand(path)]
    }
  ],
  [
    'codebuddy',
    {
      local: (path) => [
        getManagedLifecycleHook(path, {
          configDirName: '.codebuddy',
          scriptBaseName: 'codebuddy-hook',
          usesWindowsCompatLauncher: true
        }).command
      ],
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
              wrapWindowsBatchHookCommand(
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
      local: (path) => [getKimiManagedCommand(path)],
      remote: (path) => [wrapPosixHookCommand(path)]
    }
  ],
  [
    'muse',
    {
      local: (path) => [getMuseManagedCommand(path)],
      remote: (path) => [getMuseRemoteManagedCommand(path)]
    }
  ],
  [
    'dsh',
    {
      local: (path) => [getDshManagedCommand(path)],
      remote: (path) => [getDshRemoteManagedCommand(path)]
    }
  ],
  [
    'zcode',
    {
      local: (path) => [getZCodeManagedCommand(path)],
      remote: (path) => [getZCodeRemoteManagedCommand(path)]
    }
  ],
  [
    // jcode directly executes parsed argv; shell wrappers would become an invalid program name.
    'jcode',
    {
      local: (path) => [getJcodeManagedCommand(path)],
      remote: (path) => [getJcodeRemoteManagedCommand(path)]
    }
  ],
  [
    'kiro',
    {
      local: (path) => [getKiroManagedCommand(path)],
      remote: (path) => [getKiroRemoteManagedCommand(path)]
    }
  ]
])

describe('managed hook command contract', () => {
  describe.each(['darwin', 'linux', 'win32'] as const)('%s host', (platform) => {
    it.each([...buildersByAgent])('%s emits no bare variable references', (agent, builders) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const extension = platform === 'win32' ? 'cmd' : 'sh'
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
        // Native PowerShell hooks evaluate these variables without Grok's dollar-byte scanner.
        const scannedCommand =
          platform === 'win32' &&
          (agent === 'qoder' || agent === 'qoder-cn' || agent === 'qwen-code') &&
          command.startsWith('$scriptPath = Join-Path')
            ? command
                .replaceAll('$LASTEXITCODE', '')
                .replaceAll('$env:', '')
                .replaceAll('$scriptPath', '')
            : command
        expect(findBareHookCommandVariables(scannedCommand), command).toEqual([])
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
