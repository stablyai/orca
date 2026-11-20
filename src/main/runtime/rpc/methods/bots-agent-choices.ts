// `bots.agentChoices`: the agents this host's New bot offers, for a client that can't read this host's
// agent menu itself (a phone). Same rows and filter as the desktop's New bot, from this host's own facts.
import type { AgentSessionAgentAvailability } from '../../../../shared/agent-session/agent-discovery/agent-session-agent-availability'
import {
  buildNewTabAgentMenuRows,
  type HostChatAnswer
} from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { botAgentChoices } from '../../../../shared/bots/bot-agent-choices'
import { nativeChatPreferenceFor } from '../../../../shared/agent-launch/choices/structured-native-chat-launch-route'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  detectAgentsOnHost,
  HOST_DEFAULT_AGENT_DETECTION
} from '../../../preflight/workspace-agent-detection'
import { defineMethod } from '../core'
import { hostDetectionOptions } from './preflight/preflight'

// The first health snapshot probes every agent; past this the answer goes out without it.
const AVAILABILITY_WAIT_MS = 10_000

function availabilitySnapshot(
  runtime: OrcaRuntimeService
): Promise<ReadonlyMap<string, AgentSessionAgentAvailability> | null> {
  return new Promise((resolve) => {
    let release: (() => void) | null = null
    let done = false
    const settle = (agents: ReadonlyMap<string, AgentSessionAgentAvailability> | null) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      release?.()
      resolve(agents)
    }
    const timer = setTimeout(() => settle(null), AVAILABILITY_WAIT_MS)
    release = runtime.subscribeStructuredAgentAvailability((agents) =>
      settle(new Map(agents.map((entry) => [entry.agent, entry])))
    )
    // A snapshot already taken answers inside subscribe, before `release` was assigned.
    if (done) {
      release()
    }
  })
}

export async function hostBotAgentChoices(runtime: OrcaRuntimeService) {
  const settings = runtime.requireStore().getSettings()
  const [detected, roster] = await Promise.all([
    detectAgentsOnHost(HOST_DEFAULT_AGENT_DETECTION, hostDetectionOptions(runtime)).catch(
      () => null
    ),
    availabilitySnapshot(runtime)
  ])
  const detectedIds = detected?.filter(isTuiAgent) ?? null
  // As the desktop's menu reads a host's published health: absent or refused can't chat there.
  const hostChatAnswer = (agent: string): HostChatAnswer => {
    if (!roster) {
      return 'not-yet-known'
    }
    const published = roster.get(agent)
    if (published?.state === 'refused' && published.reason === 'windows') {
      return 'windows'
    }
    return !published || published.state === 'refused' ? 'not-on-host' : 'yes'
  }
  const chatAgents = [
    ...new Set([
      'claude',
      'codex',
      ...(roster?.keys() ?? []),
      ...Object.keys(settings.nativeChatProviders ?? {}).filter((agent) =>
        nativeChatPreferenceFor(settings, agent)
      )
    ])
  ].filter(isTuiAgent)
  const rows = buildNewTabAgentMenuRows({
    settings,
    detectedOnHost: detectedIds,
    chatAgents,
    hostChatAnswer,
    chatProgram: (agent) => roster?.get(agent)?.chatProgram ?? 'unknown',
    offerAgentSetup: true,
    hostPlatform: process.platform
  })
  return botAgentChoices({
    state: 'settled',
    rows,
    detection: { detectedIds }
  })
}

export const BOT_AGENT_CHOICES_METHOD = defineMethod({
  name: 'bots.agentChoices',
  permission: 'workspace',
  params: null,
  handler: async (_params, { runtime }) => ({ agents: await hostBotAgentChoices(runtime) })
})
