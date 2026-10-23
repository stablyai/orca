import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type SkillLockSourcesArgs = {
  homeDir?: string
  stateHome?: string | null
}

function globalSkillLockPath(args: SkillLockSourcesArgs): string {
  const stateHome =
    args.stateHome === undefined
      ? args.homeDir === undefined
        ? (process.env.XDG_STATE_HOME ?? null)
        : null
      : args.stateHome
  return stateHome
    ? join(stateHome, 'skills', '.skill-lock.json')
    : join(args.homeDir ?? homedir(), '.agents', '.skill-lock.json')
}

/**
 * Each globally installed skill's recorded `source`, keyed by name.
 *
 * Only provenance is read. The lock's hash depends on whether the skills CLI reached
 * GitHub's API when it installed, so it says nothing reliable about the bytes on disk.
 */
export async function readSkillLockSources(
  args: SkillLockSourcesArgs = {}
): Promise<ReadonlyMap<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(globalSkillLockPath(args), 'utf8'))
    const skills =
      parsed && typeof parsed === 'object' && 'skills' in parsed ? parsed.skills : undefined
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
      return new Map()
    }
    return new Map(
      Object.entries(skills).flatMap(([name, entry]: [string, unknown]) =>
        entry &&
        typeof entry === 'object' &&
        'source' in entry &&
        typeof entry.source === 'string' &&
        entry.source.length > 0
          ? [[name, entry.source] as const]
          : []
      )
    )
  } catch {
    return new Map()
  }
}
