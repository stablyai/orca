import { withMirroredEvidenceReceipt } from '../../../src/shared/agent-status-freshness'
import type { MobileSessionTab } from './mobile-session-route-types'

/** Host stamps are on the host's clock, so a tab's status ages from when this phone first saw its
 *  evidence, by desktop's receipt rule for status mirrored from another machine. */
export function withSessionTabStatusReceipts(
  tabs: MobileSessionTab[],
  previous: readonly MobileSessionTab[],
  now: number
): MobileSessionTab[] {
  const previousById = new Map(previous.map((tab) => [tab.id, tab]))
  return tabs.map((tab) => {
    const prior = previousById.get(tab.id)
    if (tab.type === 'terminal' && tab.agentStatus) {
      const known = prior?.type === 'terminal' ? (prior.agentStatus ?? undefined) : undefined
      return { ...tab, agentStatus: withMirroredEvidenceReceipt(tab.agentStatus, known, now) }
    }
    if (tab.type === 'agent-session' && tab.chatStatus) {
      const known = prior?.type === 'agent-session' ? prior.chatStatus : undefined
      return { ...tab, chatStatus: withMirroredEvidenceReceipt(tab.chatStatus, known, now) }
    }
    return tab
  })
}

/** With contact lost, only a live host vouches for a chat it holds: drop that exemption so the
 *  last state ages, as desktop's revokeAgentSessionStatusLive does. A new snapshot restores it. */
export function withoutSessionTabHostOwnership(tabs: MobileSessionTab[]): MobileSessionTab[] {
  if (!tabs.some((tab) => tab.type === 'agent-session' && tab.chatStatus?.structuredHostOwned)) {
    return tabs
  }
  return tabs.map((tab) => {
    if (tab.type !== 'agent-session' || !tab.chatStatus?.structuredHostOwned) {
      return tab
    }
    const { structuredHostOwned: _owned, ...chatStatus } = tab.chatStatus
    return { ...tab, chatStatus }
  })
}
