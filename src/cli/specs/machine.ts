import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const PROVIDER_NOTE =
  '--provider is the provider key from `orca machine ls` (plugin:<plugin>/<provider>); it can be omitted when the machine id is unique.'
const HOST_NOTE =
  'Providers run on this computer’s Orca desktop app with the Machines experiment enabled.'

export const MACHINE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['machine', 'ls'],
    summary: 'List machines from installed machine providers',
    usage: 'orca machine ls [--provider <key>] [--refresh] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'provider', 'refresh'],
    notes: ['Without --refresh this prints the cached inventory and runs no provider.', HOST_NOTE],
    examples: ['orca machine ls', 'orca machine ls --refresh --json']
  },
  {
    path: ['machine', 'wake'],
    summary: 'Wake a sleeping or archived machine',
    usage: 'orca machine wake <machine-id> [--provider <key>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'machine-id', 'provider'],
    positionalArgs: ['machine-id'],
    notes: [PROVIDER_NOTE, HOST_NOTE],
    examples: ['orca machine wake sbx-1a2b3c4d']
  },
  {
    path: ['machine', 'sleep'],
    summary: 'Put a running machine to sleep',
    usage: 'orca machine sleep <machine-id> [--provider <key>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'machine-id', 'provider'],
    positionalArgs: ['machine-id'],
    notes: [PROVIDER_NOTE, HOST_NOTE],
    examples: ['orca machine sleep sbx-1a2b3c4d']
  }
]
