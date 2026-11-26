import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { withBrowserPageTarget } from './browser-page-target'

export const BROWSER_TAB_CDP_COMMAND_SPECS: CommandSpec[] = withBrowserPageTarget([
  {
    path: ['tab', 'cdp'],
    summary: "Print a browser tab's CDP websocket endpoint for a local agent-browser",
    usage: 'orca tab cdp --page <id> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'page', 'worktree'],
    notes: [
      'Opt-in fast path: URL=$(orca tab cdp --page <id>), then agent-browser --session <your-name> --cdp "$URL" snapshot -i / click @e3 / fill @e5 "text". Use your own --session name, never Orca\'s orca-tab-<id>.',
      "Bypasses Orca's per-action guards on that tab: text withheld on password and credential pages, passkey, print, file-picker and JavaScript-dialog handling, input ownership checks and --expect-url. Use it only on pages you would let an agent read and drive without them.",
      'The endpoint is bound to 127.0.0.1 with an unguessable token. Treat it as a secret: do not log or share it. It works only against the local Orca app (no --environment or pairing) and ends when the tab closes or changes process; run the command again for a new one.',
      "Orca's own commands on the same tab keep working, but don't mix them with the direct session mid-flow."
    ]
  }
])
