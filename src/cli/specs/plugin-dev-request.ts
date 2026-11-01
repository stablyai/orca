import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/** `orca plugin dev request`; listed in PLUGIN_RUNTIME_COMMAND_SPECS. */
export const PLUGIN_DEV_REQUEST_COMMAND_SPEC: CommandSpec = {
  path: ['plugin', 'dev', 'request'],
  summary: "Call a development plugin's worker handler the way a panel's plugin.request does",
  usage:
    'orca plugin dev request <dir|plugin-key> <name> [--data <json>] [--panel <id>] [--timeout-ms <ms>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'target', 'name', 'data', 'panel', 'timeout-ms'],
  positionalArgs: ['target', 'name'],
  notes: [
    "Runs the handler the worker registered with `orca.panels.handle(name, …)` through the same bridge an open panel's `plugin.request` uses: the plugin must be an approved development plugin with `main`, and its worker starts if it is not running.",
    '--data is the input as JSON; without it the handler gets null, as `plugin.request(name)` sends. --panel sets the caller panel id the handler sees (default `orca-cli`); --timeout-ms is how long the handler may take (default 30000, at most 120000).',
    "Prints `{ pluginKey, name, result }`. A handler error fails with `plugin_request_failed` and the worker's code in `requestCode` (`unknown_method` when nothing handles the name, `timeout`, `unavailable`, or the code the handler threw).",
    'Installed plugins are refused; load the folder with `orca plugin dev load` first.'
  ],
  examples: [
    'orca plugin dev request . count --data \'{"by":1}\'',
    'orca plugin dev request acme.notes notes.list --json'
  ]
}
