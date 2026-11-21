// Best-effort visual setup must never prevent chat startup.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { StructuredAgentSessionLogger } from '../agent-session-wire/host/structured-agent-session-logger'
import { nativeChatScratchFolderFor } from './native-chat-scratch-folder'
import {
  NATIVE_CHAT_VISUALS_SKILL_NAME,
  resolveNativeChatVisualsSkillLocation,
  type NativeChatVisualsSkillLocation
} from './native-chat-visuals-skill-location'

/** Keep the per-chat path in the child environment rather than generated skill text. */
export const NATIVE_CHAT_SCRATCH_DIR_ENV = 'ORCA_CHAT_SCRATCH_DIR'

/** Strip the legacy name so launching Orca from a chat cannot leak that folder to new agents. */
export const LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV = 'ORCA_CHAT_VISUALS_DIR'

export type NativeChatVisualsLaunch = {
  folder: string
  skill: NativeChatVisualsSkillLocation
}

/** null disables visuals; preparation never throws. */
export type PrepareNativeChatVisuals = (
  sessionId: string
) => Promise<NativeChatVisualsLaunch | null>

type NativeChatVisualsSwitch = {
  isEnabled?: () => boolean
  resolveSkill?: () => Promise<NativeChatVisualsSkillLocation | null>
}

/** The bundled visuals skill while visuals are on; null when off or missing from this install.
 *  A chat's launch and its resting `/` probe both load it from here. */
export async function enabledNativeChatVisualsSkill(
  deps: NativeChatVisualsSwitch
): Promise<NativeChatVisualsSkillLocation | null> {
  if (deps.isEnabled?.() === false) {
    return null
  }
  return (deps.resolveSkill ?? (() => resolveNativeChatVisualsSkillLocation()))()
}

export function createNativeChatVisualsDelivery(
  deps: NativeChatVisualsSwitch & {
    stateDirectory: string
    logger: StructuredAgentSessionLogger
  }
): PrepareNativeChatVisuals {
  return async (sessionId) => {
    try {
      if (deps.isEnabled?.() === false) {
        return null
      }
      const skill = await enabledNativeChatVisualsSkill(deps)
      if (!skill) {
        deps.logger.warn('native-chat visuals skill is missing from this install', {
          scope: 'nativeChatVisuals.skill',
          sessionId
        })
        return null
      }
      const folder = nativeChatScratchFolderFor(deps.stateDirectory, sessionId)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      return { folder, skill }
    } catch (error) {
      deps.logger.warn('native-chat scratch folder could not be prepared', {
        scope: 'nativeChatVisuals.folder',
        sessionId,
        error
      })
      return null
    }
  }
}

/** Remove inherited folder values when visuals are unavailable to prevent cross-chat writes. */
export function withNativeChatVisualsEnv(
  env: Record<string, string>,
  visuals: NativeChatVisualsLaunch | null
): Record<string, string> {
  const {
    [NATIVE_CHAT_SCRATCH_DIR_ENV]: _inherited,
    [LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV]: _inheritedLegacy,
    ...rest
  } = env
  return visuals ? { ...rest, [NATIVE_CHAT_SCRATCH_DIR_ENV]: visuals.folder } : rest
}

/** Standing instructions that point an agent which cannot load skills at the visuals skill. */
export function nativeChatVisualsSection(skill: NativeChatVisualsSkillLocation): string {
  const file = join(skill.skillsRoot, NATIVE_CHAT_VISUALS_SKILL_NAME, 'SKILL.md')
  return [
    '## Inline visuals',
    '',
    `Orca can show a chart, diagram, table, report or mockup inline in this chat as an HTML page. When a visual would help, read ${file} first and follow it.`
  ].join('\n')
}
