import { useRef } from 'react'
import type { AutomationDraft } from './automation-draft'

export function useAutomationTargetDrafts() {
  const targetDrafts = useRef(
    new Map<
      string,
      Pick<
        AutomationDraft,
        'setupId' | 'workspaceMode' | 'workspaceId' | 'agentId' | 'reuseSession'
      >
    >()
  )
  return (current: AutomationDraft, patch: Partial<AutomationDraft>): AutomationDraft => {
    const key = (value: AutomationDraft, depth: number) =>
      JSON.stringify([value.setupId, value.workspaceMode, value.workspaceId].slice(0, depth))
    const { setupId, workspaceMode, workspaceId, agentId, reuseSession } = current
    for (const depth of [1, 2, 3]) {
      targetDrafts.current.set(key(current, depth), {
        setupId,
        workspaceMode,
        workspaceId,
        agentId,
        reuseSession
      })
    }
    const next = { ...current, ...patch }
    const depth = 'setupId' in patch ? 1 : 'workspaceMode' in patch ? 2 : 3
    return {
      ...current,
      ...(key(next, 3) === key(current, 3)
        ? {}
        : (targetDrafts.current.get(key(next, depth)) ?? patch)),
      targetEdited: true
    }
  }
}
