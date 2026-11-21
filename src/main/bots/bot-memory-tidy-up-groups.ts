// The copies of each fact a tidy-up takes out, checked against MEMORY.md as it is when it writes.
import { botMemoryLineKey } from '../../shared/bot-memory-lines'

/** Whether `file` still has exactly `groups`' lines for each fact, as written: a copy added,
 *  undated or rewritten since the run read the file means it must not take them. */
export function liveGroupsMatch(
  groups: ReadonlyMap<string, readonly string[]>,
  file: string
): boolean {
  const live = new Map<string, string[]>()
  for (const line of file.split(/\r?\n/)) {
    const key = botMemoryLineKey({ line, after: null })
    if (key !== null && groups.has(key)) {
      const group = live.get(key)
      if (group) {
        group.push(line.trimEnd())
      } else {
        live.set(key, [line.trimEnd()])
      }
    }
  }
  return [...groups].every(
    ([key, lines]) => JSON.stringify(live.get(key)?.toSorted() ?? []) === JSON.stringify(lines)
  )
}
