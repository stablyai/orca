import {
  CHIME_MODE_KEY,
  DEFAULT_CHIME_MODE,
  DEFAULT_PROJECT_NAME_MODE,
  PROJECT_NAME_MODE_KEY,
  type ChimeMode,
  type ProjectNameMode
} from '../storage/speech-preferences'
import { createStoredChoice } from './stored-choice'

// Why: with several agents running, the project name tells whose message follows without a look.
export const useProjectNameMode = createStoredChoice<ProjectNameMode>(
  PROJECT_NAME_MODE_KEY,
  ['on-change', 'every', 'off'],
  DEFAULT_PROJECT_NAME_MODE
)

export const useChimeMode = createStoredChoice<ChimeMode>(
  CHIME_MODE_KEY,
  ['on-change', 'every', 'off'],
  DEFAULT_CHIME_MODE
)

export const PROJECT_NAME_REPEAT_AFTER_MS = 2 * 60_000

/** "MobileApp" → "Mobile App", "on-the_road" → "on the road": TTS reads a joined name as one word. */
export function spokenProjectName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type LastReadMessage = { readonly project: string | null; readonly at: number }

function introDue(
  mode: ProjectNameMode,
  project: string | null,
  last: LastReadMessage | null,
  now: number
): boolean {
  if (mode !== 'on-change') {
    return mode === 'every'
  }
  return !(
    last !== null &&
    last.project === project &&
    now - last.at < PROJECT_NAME_REPEAT_AFTER_MS
  )
}

export function projectNameIntro(
  mode: ProjectNameMode,
  project: string | null,
  last: LastReadMessage | null,
  now: number
): string | null {
  return project && introDue(mode, project, last, now) ? spokenProjectName(project) : null
}

export function chimeBeforeMessage(
  mode: ChimeMode,
  project: string | null,
  last: LastReadMessage | null,
  now: number
): boolean {
  return introDue(mode, project, last, now)
}
