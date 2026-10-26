import { withMirroredEvidenceReceipt } from '../../../src/shared/agent-status-freshness'
import type { MobileSessionTab } from './mobile-session-route-types'

// Age host evidence from phone receipt time so clock skew cannot prolong live status.
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

// Contact loss removes host-owned liveness exemptions so status ages until a fresh snapshot restores ownership.
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
