import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const PLUGIN_SETTINGS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'settings', 'get'],
    summary: "Read a plugin's declared settings, including defaults",
    usage: 'orca plugin settings get <plugin-key> [<key>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'key'],
    positionalArgs: ['plugin', 'key'],
    notes: [
      'Reads only contributes.settings, as Settings → Plugins does; never reads secrets or undeclared settings.',
      'Runs on the selected host; --environment selects a paired Orca server. Requires host-admin.',
      'Prints { pluginKey, settings, values }; an unset key without a default is absent from values.',
      'Exit codes: 0 ok, 1 error.'
    ],
    examples: [
      'orca plugin settings get acme.notes --json',
      'orca plugin settings get acme.notes board --environment build-box --json'
    ]
  },
  {
    path: ['plugin', 'settings', 'set'],
    summary: 'Set one declared plugin setting, or restore its default with null',
    usage: 'orca plugin settings set <plugin-key> <key> <json-value|null> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'key', 'value'],
    positionalArgs: ['plugin', 'key', 'value'],
    notes: [
      'Uses the validation and persistence of Settings → Plugins and notifies open panels and a running worker.',
      'Pass valid JSON: quote strings as JSON inside shell quotes. false, 0 and an empty JSON string are values; null removes the override.',
      'Runs on the selected host; --environment selects a paired Orca server. Requires host-admin. Prints { pluginKey, key, value } with the effective value (null when unset without a default).',
      'Exit codes: 0 ok, 1 error.'
    ],
    examples: [
      'orca plugin settings set acme.notes enabled false',
      'orca plugin settings set acme.notes board \'"backlog"\' --json',
      'orca plugin settings set acme.notes board null --json'
    ]
  }
]
