// The picks a published link was built from, saved so Update link starts there. A tick on a skill
// linked into a project from outside it is saved with its folder's key, so it holds only while the
// skill is linked in from that same folder.
import type { BotSharePicks } from '../../../shared/bots/bot-share-picks'
import type { BotShareOutsidePick } from '../../../shared/bots/bot-share-skill-picks'
import type { NotedCandidate } from './bot-package-export'
import type { BotShareable } from './bot-share-sources'

/** The picks and note a published candidate was built from. An outside tick is kept only for the folder
 *  the candidate was built from, so the saved picks match what the link carries. */
export function savedPicks(candidate: NotedCandidate): BotSharePicks {
  const selection: BotSharePicks['selection'] = {}
  for (const part of ['skills', 'tools', 'schedules', 'eventSuggestions', 'memory'] as const) {
    const names = candidate.selection[part]
    if (names) {
      selection[part] = [...names]
    }
  }
  const packed = candidate.content.bot.skills
  const outside = currentTicks(candidate.selection.outsideSkills, candidate.shareable)?.filter(
    (pick) => packed.some((skill) => skill.name === pick.name)
  )
  if (outside && outside.length > 0) {
    selection.outsideSkills = outside.map(({ name, key }) => ({ name, key }))
  }
  return { selection, setupNote: candidate.content.bot.setupNote ?? '' }
}

/** The saved picks for Update link, less skills no longer there and outside ticks whose skill is now
 *  inside its project or linked in from another folder. */
export function restoredPicks(
  last: BotSharePicks,
  shareable: Pick<BotShareable, 'skills'>
): BotSharePicks {
  const present = (name: string) => shareable.skills.some((skill) => skill.name === name)
  const { skills, outsideSkills } = last.selection
  const ticks = currentTicks(outsideSkills, shareable)
  return {
    ...last,
    selection: {
      ...last.selection,
      ...(skills ? { skills: skills.filter(present) } : {}),
      ...(ticks ? { outsideSkills: ticks } : {})
    }
  }
}

/** The ticks whose skill is still linked in from the folder each was ticked in. */
function currentTicks(
  ticks: readonly BotShareOutsidePick[] | undefined,
  shareable: Pick<BotShareable, 'skills'>
): BotShareOutsidePick[] | undefined {
  return ticks?.filter((pick) =>
    shareable.skills.some((skill) => skill.name === pick.name && skill.optInKey === pick.key)
  )
}
