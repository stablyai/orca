// A skill linked into a project from outside it goes out only when the owner ticked it. Saved picks
// keep where each such ticked skill was, so Update link restores that choice, and a skill that was
// inside its project when ticked starts unticked once it is linked in from outside.
import type { BotSharePicks } from '../../../shared/bots/bot-share-picks'
import type { NotedCandidate } from './bot-package-export'
import type { BotShareable } from './bot-share-sources'

/** The picks and note a published candidate was built from, with the outside skills it ticked. */
export function savedPicks(candidate: NotedCandidate): BotSharePicks {
  const selection: BotSharePicks['selection'] = {}
  for (const part of ['skills', 'tools', 'schedules', 'eventSuggestions', 'memory'] as const) {
    const names = candidate.selection[part]
    if (names) {
      selection[part] = [...names]
    }
  }
  const outsideSkills = outsideSkillPicks(selection.skills, candidate.shareable)
  const setupNote = candidate.content.bot.setupNote ?? ''
  return { selection, setupNote, ...(outsideSkills ? { outsideSkills } : {}) }
}

/** The outside skills a picked list names, with their folders, for the saved picks. */
export function outsideSkillPicks(
  names: readonly string[] | undefined,
  shareable: Pick<BotShareable, 'skills'>
): BotSharePicks['outsideSkills'] {
  const outside = shareable.skills
    .filter((skill) => skill.optInFrom !== undefined && names?.includes(skill.name))
    .map(({ name, directory }) => ({ name, directory }))
  return outside.length > 0 ? outside : undefined
}

/** The saved picks, less any skill now outside its project that wasn't ticked from that folder. */
export function restoredPicks(
  last: BotSharePicks,
  shareable: Pick<BotShareable, 'skills'>
): BotSharePicks {
  const names = last.selection.skills
  if (names === undefined) {
    return last
  }
  const skills = names.filter((name) => {
    const skill = shareable.skills.find((entry) => entry.name === name)
    return (
      skill?.optInFrom === undefined ||
      (last.outsideSkills ?? []).some(
        (picked) => picked.name === name && picked.directory === skill.directory
      )
    )
  })
  return { ...last, selection: { ...last.selection, skills } }
}
