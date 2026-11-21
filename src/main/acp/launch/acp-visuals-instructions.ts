// Agents that cannot load Orca's visuals skill learn of it from their standing instructions.

import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { nativeChatVisualsSection } from '../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { NativeChatVisualsSkillLocation } from '../../native-chat/conversation-files/native-chat-visuals-skill-location'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { acpLaunchInstructions, type AcpInstructionsLaunch } from './acp-instructions'

/** Whether the visuals skill may reach this agent through its standing instructions. */
export function visualsByInstructions(spec: AcpLaunchSpec): boolean {
  return spec.instructions !== undefined && !spec.instructionsInWorkspace
}

/** Adds the visuals section for an unloaded skill; visuals never stop a chat that would start without them. */
export async function acpInstructionsWithVisuals(
  spec: AcpLaunchSpec,
  deps: { dataDirectory: string; logger?: StructuredAgentSessionLogger },
  input: Parameters<typeof acpLaunchInstructions>[2],
  unloadedSkill: NativeChatVisualsSkillLocation | null
): Promise<{ launch: AcpInstructionsLaunch | null; visuals: boolean }> {
  if (unloadedSkill && visualsByInstructions(spec)) {
    const section = nativeChatVisualsSection(unloadedSkill)
    try {
      const launch = await acpLaunchInstructions(spec, deps.dataDirectory, {
        ...input,
        text: input.text ? `${input.text}\n\n${section}` : section
      })
      return {
        launch: launch && !input.text ? { ...launch, sessionMetaOptional: true } : launch,
        visuals: true
      }
    } catch (error) {
      deps.logger?.warn(
        `${spec.agent} cannot take the visuals instructions; the chat has no visuals`,
        {
          scope: 'nativeChatVisuals.acp',
          sessionId: input.sessionId,
          error
        }
      )
    }
  }
  return { launch: await acpLaunchInstructions(spec, deps.dataDirectory, input), visuals: false }
}
