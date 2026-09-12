import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_ATTACH_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'attach'],
  summary: 'Attach to a live terminal with an interactive PTY',
  usage: 'orca terminal attach [--terminal <handle>] [--read-only]',
  allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'read-only'],
  notes: [
    'Bridges the local terminal directly to the Orca daemon: keystrokes are written to the session and output streams back live.',
    'Detach with Ctrl-\\ then q. The session and its process keep running; attach never kills.',
    '--read-only mirrors output without writing to or resizing the session; Ctrl-\\ then q still detaches.',
    'The daemon streams a session to one client at a time, so attaching takes over the live stream from the Orca desktop pane (it reconnects when you detach).',
    'Local-only: terminals owned by a remote/SSH runtime cannot be attached. Run this command on the remote host, or use the Orca desktop UI.'
  ],
  examples: [
    'orca terminal attach',
    'orca terminal attach --terminal term_abc123',
    'orca terminal attach --terminal term_abc123 --read-only'
  ]
}
