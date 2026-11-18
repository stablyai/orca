// What a resting chat's `/` probe loads: the same discovery inputs its launch would get, so the
// provider lists what the chat would load, without starting it.
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { NO_LINKED_SKILLS } from '../../../native-chat/native-chat-skill-roots'
import { enabledNativeChatVisualsSkill } from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { ClaudeCliLaunch } from '../../../claude/cli-capabilities/claude-cli-flag-support'
import {
  claudeDiscoveryArgs,
  claudeDiscoveryOptions
} from '../../../claude/structured/launch/claude-discovery-options'
import { claudeTakesPluginDirs } from '../../../claude/structured/launch/claude-structured-launch-flags'
import { codexSkillRoots } from '../../../codex/structured/launch/codex-structured-skill-roots'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'

type AtRestDiscoveryDeps = Pick<
  StructuredAgentSessionRuntimeDeps,
  | 'prepareSessionLinkedSkills'
  | 'readOnlySession'
  | 'nativeChatVisuals'
  | 'resolveLaunchArgs'
  | 'stateDirectory'
  | 'claudeCliFlags'
>

/** The bot folder a launch would load; rejects when it can't be brought up to date. */
async function linkedSkills(deps: AtRestDiscoveryDeps, record: AgentSessionRecord) {
  return (await deps.prepareSessionLinkedSkills?.(record)) ?? NO_LINKED_SKILLS
}

/** The visuals skill a launch would load: none for a read-only chat, or with visuals off. */
async function visualsSkill(deps: AtRestDiscoveryDeps, record: AgentSessionRecord) {
  return !deps.nativeChatVisuals || deps.readOnlySession?.(record.sessionId)
    ? null
    : enabledNativeChatVisualsSkill({ isEnabled: deps.nativeChatVisuals.isEnabled })
}

/** Claude's discovery flags for a resting chat, minus its own scratch folder (output, not skills). */
export function claudeAtRestDiscovery(deps: AtRestDiscoveryDeps) {
  return async (record: AgentSessionRecord, launch: ClaudeCliLaunch): Promise<string[]> => {
    const [linked, visuals, configuredArgs] = await Promise.all([
      linkedSkills(deps, record),
      visualsSkill(deps, record),
      deps.resolveLaunchArgs('claude')
    ])
    const plugins = visuals && (await claudeTakesPluginDirs(deps.claudeCliFlags, launch))
    return claudeDiscoveryArgs(
      claudeDiscoveryOptions({
        configuredArgs,
        attachmentDirectory: agentSessionAttachmentStoreRoot(deps.stateDirectory),
        visuals: visuals && { pluginDir: plugins ? visuals.pluginDir : null },
        linkedRoot: linked.root
      })
    )
  }
}

/** Codex's skill roots for a resting chat. A bot with no linked projects passes no linked root, so
 *  it shares the probe of chats without one; a link change retires its menu. */
export function codexAtRestSkillRoots(deps: AtRestDiscoveryDeps) {
  return async (record: AgentSessionRecord): Promise<string[]> => {
    const [linked, visuals] = await Promise.all([
      linkedSkills(deps, record),
      visualsSkill(deps, record)
    ])
    return codexSkillRoots({
      ...(visuals ? { visualsSkillsRoot: visuals.skillsRoot } : {}),
      ...(linked.root && linked.projects.length > 0
        ? { linkedSkillsRoot: linked.root.skillsRoot }
        : {})
    })
  }
}
