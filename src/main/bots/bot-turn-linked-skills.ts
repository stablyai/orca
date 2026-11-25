// The linked-project skills a running bot chat should have, against the list its agent was given.

import { botTurnFingerprint as fingerprint } from './bot-turn-memory-update'

const COPY = {
  skills:
    '[The skills from your linked projects, as they are now; this replaces any earlier list.]',
  noSkills:
    '[You have no skills from linked projects now; any earlier list of them no longer applies.]'
}

/** A bot's linked projects now (null: none ever), those its session's launch scanned, and the
 *  section a session's agent should have for the given projects. */
export type BotTurnLinkedSkills = {
  projects: (botId: string) => readonly string[] | null
  launchScanned: (sessionId: string) => readonly string[] | null
  listed: (botId: string, projects: readonly string[], sessionId: string) => Promise<string | null>
}

export const NO_BOT_TURN_LINKED_SKILLS: BotTurnLinkedSkills = {
  projects: () => null,
  launchScanned: () => null,
  listed: async () => null
}

export type BotTurnSkills = {
  botId: string
  /** The linked-skills section this launch has, and the one the agent was given (fingerprint;
   *  null: unknown, so the next turn sends it). */
  skillsNow: string | null
  skills: string | null
  /** The linked projects `skillsNow` reflects; null: unknown. */
  skillProjects: string | null
}

export const linkedProjectsKey = (ids: readonly string[] | null): string | null =>
  ids ? JSON.stringify([...ids].sort()) : null

/** The linked-skills replacement the agent still needs: what it was given against what it should
 *  have now. An empty list is a replacement too, so an unlinked project's skills stop applying. */
export function linkedSkillsUpdate(entry: BotTurnSkills): { text: string; skills: string } | null {
  const skills = fingerprint(entry.skillsNow)
  if (skills === entry.skills) {
    return null
  }
  return {
    text: entry.skillsNow ? `${COPY.skills}\n\n${entry.skillsNow}` : COPY.noSkills,
    skills
  }
}

/** The list for projects linked or unlinked since `entry` was set; null when none changed or a
 *  listing failed, which keeps the last good list and tries again next turn. */
export async function relinkedSkills(
  linkedSkills: BotTurnLinkedSkills,
  sessionId: string,
  entry: BotTurnSkills
): Promise<Pick<BotTurnSkills, 'skillProjects' | 'skillsNow'> | null> {
  const ids = linkedSkills.projects(entry.botId)
  const skillProjects = linkedProjectsKey(ids)
  if (skillProjects === entry.skillProjects) {
    return null
  }
  const skillsNow = await linkedSkills
    .listed(entry.botId, ids ?? [], sessionId)
    .catch(() => undefined)
  return skillsNow === undefined ? null : { skillProjects, skillsNow }
}
