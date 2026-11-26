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
      'The default fast path for agents: agent-browser --session <your-name> --cdp "$(orca tab cdp --page <id>)" snapshot -i, then click @e3, fill @e5 "text" and so on (about 20-40 ms per action). Without --page it uses the current tab. --json adds result.agentBrowser, the agent-browser that ships with Orca. Use your own --session name, never Orca\'s orca-tab-<id>.',
      'The URL stays the same for the life of the tab, across navigations, and calling again returns it. It changes when the tab closes, reloads into a new process, or Orca restarts; agent-browser then fails to connect, so run orca tab cdp again.',
      "Bypasses Orca's per-action guards on that tab: text withheld on password and credential pages, passkey, print, file-picker and JavaScript-dialog handling, input ownership checks, --expect-url and action effects. Use orca commands instead for logins, payments, passkeys, uploads and dialogs.",
      'Bound to 127.0.0.1 with an unguessable token: treat the URL as a secret and do not log or share it. Local Orca app only (no --environment or pairing). orca commands on the same tab keep working alongside it.'
    ]
  }
])
