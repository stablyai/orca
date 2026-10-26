import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const CLOUD_NOTES = [
  'Experimental: links this Orca to Orca Cloud for connectors such as Slack. The host refuses sign-in unless its experimentalConnectors setting is on.',
  'Runs on the Orca host itself; `--environment` / `--pairing-code` are rejected rather than ignored.'
]

export const CLOUD_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['cloud', 'login'],
    hidden: true,
    summary: 'Connect this Orca to Orca Cloud',
    usage: 'orca cloud login [--name <label>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    notes: [
      ...CLOUD_NOTES,
      'Prints a link and a code; open the link on any device, sign in, and type the code. Ctrl+C cancels.',
      '--name labels this machine in Slack and defaults to its host name.'
    ]
  },
  {
    path: ['cloud', 'logout'],
    hidden: true,
    summary: 'Disconnect this Orca from Orca Cloud',
    usage: 'orca cloud logout [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      ...CLOUD_NOTES,
      "Deletes this machine's Orca Cloud key, even when Orca Cloud cannot be reached. Paired phones stay paired."
    ]
  },
  {
    path: ['cloud', 'status'],
    hidden: true,
    summary: 'Show whether this Orca is connected to Orca Cloud',
    usage: 'orca cloud status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: CLOUD_NOTES
  }
]
