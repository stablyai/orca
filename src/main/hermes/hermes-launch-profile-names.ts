import {
  HERMES_PROFILE_NAME,
  readHermesProfileName
} from '../../shared/agent-launch/startup/hermes-profile'

/** Directory names under `profiles/` that launch a named profile; `default` is the root home. */
export function hermesProfileNames(names: readonly string[]): string[] {
  return names.filter((name) => name !== 'default' && HERMES_PROFILE_NAME.test(name)).sort()
}

/** The sticky `hermes profile use` choice, or null when the root home is active. */
export function hermesActiveProfileName(content: string | null): string | null {
  return content === null ? null : (readHermesProfileName(content) ?? null)
}

/** Directory entries as a runtime server lists them (`{ entries: { name, isDirectory }[] }`);
 *  anything else — an older host, a refusal — lists nothing. */
export function readServerDirNames(result: unknown): string[] {
  if (typeof result !== 'object' || result === null || !('entries' in result)) {
    return []
  }
  const { entries } = result
  return Array.isArray(entries)
    ? entries.flatMap((entry: unknown) => {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !('name' in entry) ||
          !('isDirectory' in entry)
        ) {
          return []
        }
        const { name, isDirectory } = entry
        return typeof name === 'string' && isDirectory === true ? [name] : []
      })
    : []
}
