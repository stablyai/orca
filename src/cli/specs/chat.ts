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
    path: ['chat', 'badge'],
    summary: "Pin a small picture on a chat's sidebar row, or clear it",
    usage: 'orca chat badge [--session <id>] (--icon <file> --label <text> | --clear) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'icon', 'label', 'clear'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints. Run inside a chat, it defaults to that chat; with --environment it is required.',
      '--icon is a PNG, WebP or SVG file of at most about 6 KB, such as a 32 px logo. Orca shows it beside the chat in the sidebar, with --label as its tooltip, until it is cleared or replaced.',
      'Use it to mark a chat another program is linked to; that program sets the badge when it links and clears it when it lets go.'
    ],
    examples: [
      'orca chat badge --session <sessionId> --icon blender.png --label "Linked to Blender"',
      'orca chat badge --session <sessionId> --clear --json'
    ]
  }
]
