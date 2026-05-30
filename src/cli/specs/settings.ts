import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SETTINGS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['settings', 'get'],
    summary: 'Get a browser permission setting value',
    usage: 'orca settings get --key browserInteractionMode|browserPermissionNoticePolicy [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key'],
    examples: ['orca settings get --key browserInteractionMode --json']
  },
  {
    path: ['settings', 'set'],
    summary: 'Set a browser permission setting value',
    usage:
      'orca settings set --key browserInteractionMode|browserPermissionNoticePolicy --value <value> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'value'],
    examples: [
      'orca settings set --key browserInteractionMode --value human',
      'orca settings set --key browserPermissionNoticePolicy --value important-only'
    ]
  },
  {
    path: ['browser-permissions', 'list'],
    summary: 'List remembered browser site permission rules',
    usage: 'orca browser-permissions list [--profile <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile']
  },
  {
    path: ['browser-permissions', 'allow'],
    summary: 'Remember an allow rule for a site permission',
    usage:
      'orca browser-permissions allow --origin <origin> --permission <name> [--profile <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'origin', 'permission', 'profile'],
    examples: [
      'orca browser-permissions allow --origin https://app.slack.com/client --permission notifications'
    ]
  },
  {
    path: ['browser-permissions', 'deny'],
    summary: 'Remember a deny rule for a site permission',
    usage:
      'orca browser-permissions deny --origin <origin> --permission <name> [--profile <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'origin', 'permission', 'profile']
  },
  {
    path: ['browser-permissions', 'prompt'],
    summary: 'Remember a prompt rule for a site permission',
    usage:
      'orca browser-permissions prompt --origin <origin> --permission <name> [--profile <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'origin', 'permission', 'profile']
  },
  {
    path: ['browser-permissions', 'remove'],
    summary: 'Remove a remembered site permission rule',
    usage:
      'orca browser-permissions remove --origin <origin> --permission <name> [--profile <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'origin', 'permission', 'profile']
  }
]
