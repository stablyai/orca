import type { CommandHandler } from '../dispatch'
import { HANDLER_GROUPS } from '../handler-group-manifest'
import { desktopOnlyCommandError } from '../standalone-cli-mode'

// Why: the standalone build swaps desktop-only handler modules for this record, so
// their src/main graphs (profile SQLite, hook mutators, keychain) never enter the bundle.
export function createDesktopOnlyHandlerStub(groupName: string): Record<string, CommandHandler> {
  const group = HANDLER_GROUPS.find((candidate) => candidate.name === groupName)
  if (!group) {
    throw new Error(`Unknown CLI handler group "${groupName}"`)
  }
  return Object.fromEntries(
    group.keys.map((key): [string, CommandHandler] => [
      key,
      async () => {
        throw desktopOnlyCommandError(key.split(' '))
      }
    ])
  )
}
