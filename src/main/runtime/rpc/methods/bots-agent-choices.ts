// `bots.agentChoices`: the agents this host's New bot offers, for a client that can't read this host's
// agent menu itself (a phone). Same rows and filter as the desktop's New bot, from this host's own facts.
import type { AgentSessionAgentAvailability } from '../../../../shared/agent-session/agent-discovery/agent-session-agent-availability'
import {
  agentMenuRowReady,
  agentMenuRowSupportsChat,
  buildNewTabAgentMenuRows,
  type HostChatAnswer
} from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { BOT_AGENTS, type BotAgent } from '../../../../shared/bot-types'
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

async function hostAgentMenuRows(runtime: OrcaRuntimeService, offerAgentSetup: boolean) {
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
    offerAgentSetup,
    hostPlatform: process.platform
  })
  return { rows, detectedIds, roster }
}

export async function hostBotAgentChoices(runtime: OrcaRuntimeService) {
  const { rows, detectedIds } = await hostAgentMenuRows(runtime, true)
  return botAgentChoices({
    state: 'settled',
    rows,
    detection: { detectedIds }
  })
}

/** Only agents genuinely installed and runnable on this host now (excludes uninstalled setup offers). */
export async function hostReadyBotAgents(runtime: OrcaRuntimeService): Promise<BotAgent[]> {
  const { rows, roster } = await hostAgentMenuRows(runtime, false)
  return BOT_AGENTS.filter((agent) => {
    const program = roster?.get(agent)?.chatProgram
    if (program === 'installable' || program === 'missing') {
      return false
    }
    return rows.some(
      (row) => row.agent === agent && agentMenuRowReady(row) && agentMenuRowSupportsChat(row)
    )
  })
}

export const BOT_AGENT_CHOICES_METHOD = defineMethod({
  name: 'bots.agentChoices',
  permission: 'workspace',
  params: null,
  handler: async (_params, { runtime }) => ({ agents: await hostBotAgentChoices(runtime) })
})
