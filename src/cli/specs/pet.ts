import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const PET_SELECTOR_NOTE =
  '--pet takes a pet id from `orca pet list` or the exact name of a custom pet; built-in pets are selected by id.'

export const PET_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pet', 'list'],
    summary: 'List built-in and custom pets and which one is active',
    usage: 'orca pet list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca pet list --json']
  },
  {
    path: ['pet', 'import'],
    summary: 'Import a .codex-pet bundle and make it the active pet',
    usage: 'orca pet import --path <bundle> [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'name'],
    notes: [
      '--path is the bundle folder (or its pet.json); Orca copies it, so the source can be deleted afterwards.',
      'Like the pet menu, importing shows the pet and switches to it.'
    ],
    examples: ['orca pet import --path ~/.codex/pets/leonardo-da-vinci --name "Da Vinci"']
  },
  {
    path: ['pet', 'select'],
    summary: 'Switch the active pet',
    usage: 'orca pet select --pet <id|name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pet'],
    notes: [PET_SELECTOR_NOTE, 'Selecting a pet also shows the pet if it was hidden.'],
    examples: ['orca pet select --pet claude-the-mage']
  },
  {
    path: ['pet', 'rename'],
    summary: 'Rename a custom pet',
    usage: 'orca pet rename --pet <id|name> --name <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pet', 'name'],
    notes: [PET_SELECTOR_NOTE],
    examples: ['orca pet rename --pet "Leonardo da Vinci" --name "Da Vinci"']
  },
  {
    path: ['pet', 'rm'],
    destructive: true,
    summary: 'Remove a custom pet and delete its stored files',
    usage: 'orca pet rm --pet <id|name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pet'],
    notes: [PET_SELECTOR_NOTE, 'Removing the active pet switches back to the default pet.'],
    examples: ['orca pet rm --pet "Da Vinci"']
  }
]
