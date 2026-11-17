import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat', 'rename'],
    summary: 'Rename a chat tab',
    usage: 'orca chat rename [--session <id>] --name <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'name'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints. Run inside a chat, it defaults to that chat; with --environment it is required.',
      'The name shows in the tab, the sidebar, Session History and on paired phones, the same as renaming the tab by hand.'
    ],
    examples: [
      'orca chat rename --name "Migrate auth to OAuth"',
      'orca chat rename --session <sessionId> --name "Release notes" --json'
    ]
  },
  {
    path: ['chat', 'remote-control'],
    summary: "Turn a Claude chat's Remote Control on or off, or show it",
    usage: 'orca chat remote-control [on|off|status] [--session <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'action', 'session'],
    positionalArgs: ['action'],
    notes: [
      "Remote Control shows a Claude chat in the Claude app and on claude.ai, where it can be followed and answered. It is Claude Code's own feature: the account needs a claude.ai login.",
      'on and off are saved on the chat for every device and its later starts; a running chat connects or disconnects at once. status (the default) only reads.',
      '--session takes the chat session id `orca agent launch` prints. Run inside a chat, it defaults to that chat; with --environment it is required.'
    ],
    examples: [
      'orca chat remote-control on',
      'orca chat remote-control status --session <sessionId> --json'
    ]
  }
]
