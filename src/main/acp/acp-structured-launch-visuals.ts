// What an ACP launch gets for inline visuals: the chat's folder, and whatever its agent needs to
// load the skill. Best effort: a chat whose agent can't load it starts without visuals.

import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type {
  NativeChatVisualsLaunch,
  PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpVisualsSkillLaunch } from './acp-visuals-skill'

export type AcpLaunchVisualsDeps = {
  /** Prepares a chat's inline-visuals folder; absent, no chat gets visuals. */
  prepareVisuals?: PrepareNativeChatVisuals
  logger?: StructuredAgentSessionLogger
}

/** The environment the child will see: what it inherits, the launch's laid over, then the strips. */
function childEnvironmentView(
  env: Readonly<Record<string, string>>,
  inherited: NodeJS.ProcessEnv,
  envToDelete: readonly string[]
): Record<string, string> {
  const view: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      view[key] = value
    }
  }
  Object.assign(view, env)
  for (const key of envToDelete) {
    delete view[key]
  }
  return view
}

/** How this launch's agent loads the skill for the chat's prepared `visuals`; null leaves the chat
 *  without visuals. Never throws. */
export async function loadAcpVisualsSkill(
  spec: AcpLaunchSpec,
  deps: AcpLaunchVisualsDeps,
  input: {
    sessionId: string
    visuals: NativeChatVisualsLaunch
    version: string | null
    env: Readonly<Record<string, string>>
    envToDelete: readonly string[]
    inherited: NodeJS.ProcessEnv
  }
): Promise<AcpVisualsSkillLaunch | null> {
  const { visualsSkill } = spec
  if (!visualsSkill) {
    return null
  }
  try {
    const skill = await visualsSkill({
      skill: input.visuals.skill,
      version: input.version,
      env: childEnvironmentView(input.env, input.inherited, input.envToDelete)
    })
    if (!skill) {
      deps.logger?.warn(`${spec.agent} cannot load the visuals skill; the chat has no visuals`, {
        scope: 'nativeChatVisuals.acp',
        sessionId: input.sessionId,
        version: input.version
      })
    }
    return skill
  } catch (error) {
    deps.logger?.warn(`${spec.agent} visuals skill could not be prepared`, {
      scope: 'nativeChatVisuals.acp',
      sessionId: input.sessionId,
      error
    })
    return null
  }
}
