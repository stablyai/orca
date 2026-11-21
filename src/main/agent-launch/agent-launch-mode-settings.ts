import {
  agentCopyIdFromLaunchOptions,
  applyAgentCopyById,
  type AgentCopySettings
} from '../../shared/agent-launch/catalog/agent-copies'
import type { AgentLaunchModeSettings } from './agent-launch-mode'

/** A desktop stamp supplies its resolved preference for the launched agent; other callers read the host’s settings,
 *  where a launched agent copy's own Chat | CLI choice stands in for its base agent's. */
export function readAgentLaunchModeSettings(
  runtime: {
    requireStore(): {
      getSettings(): (AgentLaunchModeSettings & AgentCopySettings) | null
    }
  },
  caller?: {
    agent?: string
    nativeChatDefault?: boolean
    sessionOptions?: Readonly<Record<string, unknown>>
    chatOptions?: Readonly<Record<string, unknown>>
  }
): AgentLaunchModeSettings | null {
  if (caller?.nativeChatDefault !== undefined) {
    return caller.agent === undefined
      ? {}
      : { nativeChatProviders: { [caller.agent]: caller.nativeChatDefault } }
  }
  try {
    const settings = runtime.requireStore().getSettings()
    const copyId = agentCopyIdFromLaunchOptions(caller?.sessionOptions, caller?.chatOptions)
    return settings && applyAgentCopyById(settings, copyId)
  } catch (error) {
    console.warn('[agent-launch] could not resolve chat preference', error)
    return null
  }
}
