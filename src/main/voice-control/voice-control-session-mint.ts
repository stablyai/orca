import type { MainHttpClient } from '../network/http-client'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type { VoiceControlSettings } from '../../shared/voice-control-types'
import {
  mintRealtimeClientSecret,
  type MintedRealtimeClientSecret
} from './openai-realtime-client-secret-mint'
import { buildCoordinatorInstructions } from './voice-control-coordinator-prompt'
import { projectVoiceRoster, type VoiceRosterEntry } from './voice-control-roster'
import { COORDINATOR_TOOLS } from './voice-control-tool-schemas'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'

/** What the coordinator mint reads beyond the api key. */
export type CoordinatorMintDeps = {
  http: Pick<MainHttpClient, 'fetch'>
  getRoster: () => Promise<RuntimeWorktreePsSummary[]>
  getSettings: () => VoiceControlSettings
  cliCommand: string
  readRecentTranscript: () => VoiceTranscriptEntry[]
}

/**
 * Mints the ephemeral client secret for one control session: the roster projection,
 * coordinator instructions (with the recent transcript as its memory), tools, and voice
 * settings are baked in here so a late mint can be dropped wholesale after a stop.
 */
export async function mintCoordinatorSession(
  deps: CoordinatorMintDeps,
  apiKey: string
): Promise<{ clientSecret: MintedRealtimeClientSecret; roster: VoiceRosterEntry[] }> {
  const roster = projectVoiceRoster(await deps.getRoster())
  const settings = deps.getSettings()
  const clientSecret = await mintRealtimeClientSecret(deps.http, apiKey, {
    instructions: buildCoordinatorInstructions({
      roster,
      coordinatorVoice: settings.coordinatorVoice,
      customInstructions: settings.customInstructions,
      cli: deps.cliCommand,
      recentHistory: deps.readRecentTranscript()
    }),
    tools: COORDINATOR_TOOLS,
    voice: settings.coordinatorVoice,
    speed: settings.voiceSpeed
  })
  return { clientSecret, roster }
}
