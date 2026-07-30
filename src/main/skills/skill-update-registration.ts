import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const GLOBAL_SKILL_LOCK_SCHEMA_VERSION = 3

type SkillUpdateRegistrationArgs = {
  homeDir?: string
  stateHome?: string | null
}

function globalSkillLockPath(args: SkillUpdateRegistrationArgs): string {
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

export async function readGloballyUpdatableSkillNames(
  args: SkillUpdateRegistrationArgs = {}
): Promise<ReadonlySet<string>> {
  return new Set((await readGloballyUpdatableSkillLocks(args)).keys())
}

/**
 * Each updatable skill's recorded `skillFolderHash`, keyed by name.
 *
 * The hash is what the updater believes it installed. It is deliberately
 * exposed alongside the names because `skills update` decides what to do by
 * comparing this against the source and never reads disk — so when it disagrees
 * with the bytes actually on disk, the command can only no-op.
 */
export async function readGloballyUpdatableSkillLocks(
  args: SkillUpdateRegistrationArgs = {}
): Promise<ReadonlyMap<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(globalSkillLockPath(args), 'utf8')) as {
      version?: unknown
      skills?: unknown
    }
    if (
      typeof parsed.version !== 'number' ||
      parsed.version < GLOBAL_SKILL_LOCK_SCHEMA_VERSION ||
      !parsed.skills ||
      typeof parsed.skills !== 'object' ||
      Array.isArray(parsed.skills)
    ) {
      return new Map()
    }

    return new Map(
      Object.entries(parsed.skills)
        .filter(([, value]) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false
          }
          const entry = value as {
            skillFolderHash?: unknown
            skillPath?: unknown
            source?: unknown
          }
          return (
            typeof entry.skillFolderHash === 'string' &&
            entry.skillFolderHash.length > 0 &&
            typeof entry.skillPath === 'string' &&
            entry.skillPath.length > 0 &&
            typeof entry.source === 'string' &&
            entry.source.length > 0
          )
        })
        .map(
          ([name, value]) => [name, (value as { skillFolderHash: string }).skillFolderHash] as const
        )
    )
  } catch {
    return new Map()
  }
}
