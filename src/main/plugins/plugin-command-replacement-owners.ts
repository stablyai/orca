import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import type { PluginLockfile } from '../../shared/plugins/installation/plugin-install-lockfile'

const LIVE = new Set(['running', 'idle', 'restarting'])
// Conflicts already logged, so a list refresh does not repeat them.
const logged = new Set<string>()

/**
 * One plugin per built-in action: the one installed first replaces it, later ones are marked
 * `replacedBy` and the conflict is logged to each loser's plugin log. Development folders, which
 * have no install time, come after installed plugins.
 */
export function markCommandReplacementOwners(
  entries: PluginHostListEntry[],
  lock: Pick<PluginLockfile, 'plugins'>,
  log: (pluginKey: string, line: string) => void
): PluginHostListEntry[] {
  const installedAt = (key: string) => lock.plugins[key]?.installedAt ?? Number.POSITIVE_INFINITY
  const owners = new Map<string, string>()
  const contenders = entries
    .filter((entry) => LIVE.has(entry.status))
    .toSorted(
      (a, b) =>
        installedAt(a.pluginKey) - installedAt(b.pluginKey) ||
        a.pluginKey.localeCompare(b.pluginKey)
    )
  for (const entry of contenders) {
    for (const command of entry.commands) {
      if (command.replaces !== undefined && !owners.has(command.replaces)) {
        owners.set(command.replaces, entry.pluginKey)
      }
    }
  }
  return entries.map((entry) => {
    if (!LIVE.has(entry.status) || !entry.commands.some((command) => command.replaces)) {
      return entry
    }
    const commands = entry.commands.map((command) => {
      const owner = command.replaces === undefined ? undefined : owners.get(command.replaces)
      if (owner === undefined || owner === entry.pluginKey) {
        return command
      }
      const conflict = `${entry.pluginKey}/${command.id}\0${owner}`
      if (!logged.has(conflict)) {
        logged.add(conflict)
        log(
          entry.pluginKey,
          `command ${command.id} does not replace ${command.replaces}: ${owner} was installed first and replaces it`
        )
      }
      return { ...command, replacedBy: owner }
    })
    return { ...entry, commands }
  })
}
