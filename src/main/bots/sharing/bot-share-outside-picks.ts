// A skill linked into a project from outside it goes out only when the owner ticked it. Saved picks
// keep where each such ticked skill was, so Update link restores that choice, and a skill that was
// inside its project when ticked starts unticked once it is linked in from outside.
import {
  BOT_SHARE_PICK_DIRECTORY_MAX,
  type BotShareOutsidePick,
  type BotSharePicks
} from '../../../shared/bots/bot-share-picks'
import type { BotShareSelection, NotedCandidate } from './bot-package-export'
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

/** The outside skills a picked list names, with their folders, for the saved picks. A folder too long
 *  to save is left out, so that skill starts unticked next time; the other picks and note still save. */
export function outsideSkillPicks(
  names: readonly string[] | undefined,
  shareable: Pick<BotShareable, 'skills'>
): BotSharePicks['outsideSkills'] {
  const outside = outsideSkillsOf(shareable).filter(
    (pick) => names?.includes(pick.name) && pick.directory.length <= BOT_SHARE_PICK_DIRECTORY_MAX
  )
  return outside.length > 0 ? outside : undefined
}

/** Every skill linked into a project from outside it, with its folder. */
export function outsideSkillsOf(shareable: Pick<BotShareable, 'skills'>): BotShareOutsidePick[] {
  return shareable.skills
    .filter((skill) => skill.optInFrom !== undefined)
    .map(({ name, directory }) => ({ name, directory }))
}

/** The saved picks for Update link: a skill no longer there is dropped, and so is one now outside its
 *  project that wasn't ticked from that folder. */
export function restoredPicks(
  last: BotSharePicks,
  shareable: Pick<BotShareable, 'skills'>
): BotSharePicks {
  const selection = consentedSelection(last.selection, shareable, last.outsideSkills ?? [])
  return { ...last, selection: { ...last.selection, ...selection } }
}

/** The picks with each named skill that is outside its project kept only with the owner's consent for
 *  that folder: ticked from it before (`consent`). A name for a skill that isn't there is dropped. */
export function consentedSelection<T extends Pick<BotShareSelection, 'skills'>>(
  selection: T,
  shareable: Pick<BotShareable, 'skills'>,
  consent: readonly BotShareOutsidePick[]
): T {
  const names = selection.skills
  if (names === undefined) {
    return selection
  }
  const skills = names.filter((name) => {
    const skill = shareable.skills.find((entry) => entry.name === name)
    return (
      skill !== undefined &&
      (skill.optInFrom === undefined ||
        consent.some((pick) => pick.name === name && pick.directory === skill.directory))
    )
  })
  return { ...selection, skills }
}

/** The request with a ticked skill now outside its project kept only if the owner saw it outside, in
 *  that folder, when they ticked it: on a candidate this one replaces (`shown`), or in saved picks. */
export function withOutsideConsent<
  T extends {
    selection: BotShareSelection
    shareable: Pick<BotShareable, 'skills'>
    outsideConsent?: readonly BotShareOutsidePick[]
  }
>(request: T, shown: readonly Pick<BotShareable, 'skills'>[]): T {
  const consent = [...(request.outsideConsent ?? []), ...shown.flatMap(outsideSkillsOf)]
  return {
    ...request,
    selection: consentedSelection(request.selection, request.shareable, consent)
  }
}
