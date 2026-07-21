import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FINDER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['finder', 'terminal'],
    summary: 'Open a Finder-selected folder in an Orca terminal',
    usage: 'orca finder terminal --path <absolute-folder> [--title <title>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'title']
  },
  {
    path: ['finder', 'workspace'],
    summary: 'Open a Finder-selected folder as an Orca workspace',
    usage: 'orca finder workspace --path <absolute-folder> [--name <name>] [--terminal] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'name', 'terminal']
  }
]
