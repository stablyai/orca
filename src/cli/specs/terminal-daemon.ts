import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_DAEMON_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['terminal-daemon', 'status'],
    summary:
      'Report whether the terminal daemon is running, its process ceiling, and whether it still has its program files',
    usage: 'orca terminal-daemon status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'The daemon is reported live, exited, or unverifiable. Orca starts a new daemon with the next terminal after one exits, so exited between a crash and that terminal is expected.',
      'For a live daemon it also reports the terminal process ceiling: on with its limit, or off with the reason.',
      'On Linux AppImage, a daemon started by an earlier Orca can outlive the files it runs from. Orca keeps it so its terminals keep running, but new terminals are not kept across restarts until it is restarted.'
    ],
    examples: ['orca terminal-daemon status --json']
  },
  {
    path: ['terminal-daemon', 'restart'],
    destructive: true,
    summary: 'Restart a terminal daemon whose program files are gone',
    usage: 'orca terminal-daemon restart --yes [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'yes'],
    notes: [
      'Restarting ENDS every process running in its terminals. Agents that support resume can be resumed afterwards; shells and other jobs must be started again.',
      'The host re-checks that the daemon is still the one reported by status before stopping it, and refuses otherwise.'
    ],
    examples: ['orca terminal-daemon restart --yes']
  }
]
