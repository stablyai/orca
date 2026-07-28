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
      return new Set()
    }

    return new Set(
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
        .map(([name]) => name)
    )
  } catch {
    return new Set()
  }
}
