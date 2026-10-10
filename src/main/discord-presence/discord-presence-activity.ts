import type { DiscordActivity } from './discord-ipc-client'

/** Art asset uploaded to Orca's Discord application under this key. */
export const DISCORD_PRESENCE_LARGE_IMAGE_KEY = 'orca'

export type DiscordPresenceSnapshot = {
  workingAgentCount: number
  /** Agents blocked on a permission prompt or waiting for the user's next message. */
  waitingAgentCount: number
  sessionStartedAt: number
}

type Translate = (key: string, fallback: string, options?: { count: number }) => string

function describeWorking(count: number, translate: Translate): string {
  return count === 1
    ? translate('discordPresence.runningOneAgent', 'Running 1 agent')
    : translate('discordPresence.runningAgents', 'Running {{count}} agents', { count })
}

function describeWaiting(count: number, translate: Translate): string {
  return count === 1
    ? translate('discordPresence.oneAgentWaiting', '1 agent waiting for input')
    : translate('discordPresence.agentsWaiting', '{{count}} agents waiting for input', { count })
}

/** Carries counts only: project, branch, and file names never leave the machine. */
export function buildDiscordPresenceActivity(
  snapshot: DiscordPresenceSnapshot,
  translate: Translate
): DiscordActivity {
  const { workingAgentCount, waitingAgentCount } = snapshot
  let details: string
  let state: string | undefined
  if (workingAgentCount > 0) {
    details = describeWorking(workingAgentCount, translate)
    state = waitingAgentCount > 0 ? describeWaiting(waitingAgentCount, translate) : undefined
  } else if (waitingAgentCount > 0) {
    details = describeWaiting(waitingAgentCount, translate)
  } else {
    details = translate('discordPresence.idle', 'Idle')
  }
  return {
    type: 0,
    details,
    ...(state ? { state } : {}),
    timestamps: { start: snapshot.sessionStartedAt },
    assets: {
      large_image: DISCORD_PRESENCE_LARGE_IMAGE_KEY,
      large_text: 'Orca'
    }
  }
}
