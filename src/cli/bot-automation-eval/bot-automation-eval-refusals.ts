// Commands the stand-in refuses: they write outside the bot's folder (launch agents, the owner's
// skill folders) or publish, not through a host.
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import { COMMAND_SPECS } from '../specs'

const WRITES_OWNER_FILES = [
  ['serve'],
  ['open'],
  ['skills', 'install'],
  ['skills', 'update'],
  ['skills', 'share']
]

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

/** The refused command as the CLI itself reads argv (global flags may come first), or null. */
export function refusedCommand(argv: string[]): string | null {
  const { commandPath } = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(argv, COMMAND_PATHS, COMMAND_SPECS)
  )
  const refused = WRITES_OWNER_FILES.find((path) =>
    path.every((word, index) => commandPath[index] === word)
  )
  return refused ? refused.join(' ') : null
}
