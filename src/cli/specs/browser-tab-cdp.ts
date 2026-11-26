import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { withBrowserPageTarget } from './browser-page-target'

export const BROWSER_TAB_CDP_COMMAND_SPECS: CommandSpec[] = withBrowserPageTarget([
  {
    path: ['tab', 'cdp'],
    summary: "Print a browser tab's CDP websocket endpoint for a local agent-browser",
    usage: 'orca tab cdp [--page <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Opt-in fast path: agent-browser --session <your-name> --cdp "$(orca tab cdp --page <id>)" snapshot -i, then click @e3, fill @e5 "text" and so on. Without --page it uses the current tab. Use your own --session name, never Orca\'s orca-tab-<id>.',
      'The URL stays the same for the life of the tab, across navigations, and calling again returns it. It changes when the tab closes, reloads into a new process, or Orca restarts; agent-browser then fails to connect, so run orca tab cdp again.',
      "Bypasses Orca's per-action guards on that tab: text withheld on password and credential pages, passkey, print, file-picker and JavaScript-dialog handling, input ownership checks, --expect-url and action effects. Use it only on pages you would let an agent read and drive without them.",
      'Bound to 127.0.0.1 with an unguessable token: treat the URL as a secret and do not log or share it. Local Orca app only (no --environment or pairing). orca commands on the same tab keep working alongside it.'
    ]
  }
])
