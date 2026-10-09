// What a structured chat launch gets for inline visuals: its own writable folder, named to the agent
// in an environment variable, and where this host keeps the skill that teaches the reply line.
// Every step is best effort: a chat without visuals still starts.

import { mkdir } from 'node:fs/promises'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { nativeChatVisualsFolderFor } from './native-chat-visuals-folder'
import {
  resolveNativeChatVisualsSkillLocation,
  type NativeChatVisualsSkillLocation
} from './native-chat-visuals-skill-location'

/** The agent child's variable holding its chat's visuals folder. The skill reads it; the path is
 *  never written into the skill text. */
export const NATIVE_CHAT_VISUALS_DIR_ENV = 'ORCA_CHAT_VISUALS_DIR'

export type NativeChatVisualsLaunch = {
  /** This chat's folder, created and private to this user. */
  folder: string
  skill: NativeChatVisualsSkillLocation
}

/** Prepares one chat's launch; null leaves the chat without visuals. Never throws. */
export type PrepareNativeChatVisuals = (
  sessionId: string
) => Promise<NativeChatVisualsLaunch | null>

export function createNativeChatVisualsDelivery(deps: {
  stateDirectory: string
  logger: StructuredAgentSessionLogger
  isEnabled?: () => boolean
  resolveSkill?: () => Promise<NativeChatVisualsSkillLocation | null>
}): PrepareNativeChatVisuals {
  const resolveSkill = deps.resolveSkill ?? (() => resolveNativeChatVisualsSkillLocation())
  return async (sessionId) => {
    try {
      if (deps.isEnabled?.() === false) {
        return null
      }
      const skill = await resolveSkill()
      if (!skill) {
        deps.logger.warn('native-chat visuals skill is missing from this install', {
          scope: 'nativeChatVisuals.skill',
          sessionId
        })
        return null
      }
      const folder = nativeChatVisualsFolderFor(deps.stateDirectory, sessionId)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      return { folder, skill }
    } catch (error) {
      deps.logger.warn('native-chat visuals folder could not be prepared', {
        scope: 'nativeChatVisuals.folder',
        sessionId,
        error
      })
      return null
    }
  }
}

/** `env` naming this chat's folder; without visuals, an inherited value (Orca itself started from
 *  a chat) is removed so the agent never writes into another chat's folder. */
export function withNativeChatVisualsEnv(
  env: Record<string, string>,
  visuals: NativeChatVisualsLaunch | null
): Record<string, string> {
  const { [NATIVE_CHAT_VISUALS_DIR_ENV]: _inherited, ...rest } = env
  return visuals ? { ...rest, [NATIVE_CHAT_VISUALS_DIR_ENV]: visuals.folder } : rest
}
