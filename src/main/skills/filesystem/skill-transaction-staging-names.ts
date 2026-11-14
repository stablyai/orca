/** The `find -name` glob the WSL guest script prunes on. */
export const SKILL_STAGING_GLOB = '.*.orca-*'

const SKILL_STAGING_NAME = /^\..+\.orca-/u

export function isSkillStagingEntryName(name: string): boolean {
  return SKILL_STAGING_NAME.test(name)
}
