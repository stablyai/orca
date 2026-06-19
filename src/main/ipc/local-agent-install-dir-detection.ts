import path from 'path'
import { resolveCliCommands } from '../codex-cli/command'

// Why: local agent detection may run before shell-PATH hydration, but the
// fallback must stay bounded because it runs on the main process.
export function detectCommandsInInstallDirs(commands: readonly string[]): Set<string> {
  if (commands.length === 0) {
    return new Set()
  }
  try {
    const resolvedCommands = resolveCliCommands(commands)
    return new Set(
      commands.filter((command) => path.isAbsolute(resolvedCommands.get(command) ?? command))
    )
  } catch {
    return new Set()
  }
}
