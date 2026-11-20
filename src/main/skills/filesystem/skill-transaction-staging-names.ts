/** The `find -name` glob the WSL guest script prunes on. */
export const SKILL_STAGING_GLOB = '.*.orca-*'

const SKILL_STAGING_NAME = /^\..+\.orca-/u

/** Claude Code parks replaced copies in `.trash` and an in-progress sync in `.staging`. */
export const CLAUDE_SYNC_SCRATCH_DIRECTORY_NAMES: readonly string[] = ['.trash', '.staging']

export function isSkillStagingEntryName(name: string): boolean {
  return SKILL_STAGING_NAME.test(name)
}

export function isClaudeSyncScratchDirectory(name: string): boolean {
  return CLAUDE_SYNC_SCRATCH_DIRECTORY_NAMES.includes(name)
}
