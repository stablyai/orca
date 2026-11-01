import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatSubagentActivity } from '../../../../../src/shared/native-chat/input/native-chat-activity'
import {
  nativeChatDismissSubagents,
  nativeChatReconcileDismissals,
  nativeChatVisibleDismissedSubagents,
  type DismissedSubagentStates
} from '../../../../../src/shared/native-chat/input/native-chat-subagent-dismissals'
import {
  readMirroredKeyOrStore,
  subscribeMirroredKey
} from '../../../storage/mirrored-storage-keys'
import {
  dismissedSubagentsInSession,
  dismissedSubagentsStorageKey,
  writeDismissedSubagentSession
} from '../../../storage/dismissed-subagents'

export type MobileDismissedSubagentScope = {
  hostId: string
  worktreeId: string
  sessionId: string | null
}

function sameDismissals(left: DismissedSubagentStates, right: DismissedSubagentStates): boolean {
  const leftIds = Object.keys(left)
  return (
    leftIds.length === Object.keys(right).length && leftIds.every((id) => left[id] === right[id])
  )
}

export function useMobileDismissedSubagents(
  scope: MobileDismissedSubagentScope | null,
  listed: readonly NativeChatSubagentActivity[]
): {
  visible: NativeChatSubagentActivity[]
  dismiss: (agents: readonly NativeChatSubagentActivity[]) => void
} {
  const hostId = scope?.hostId ?? null
  const worktreeId = scope?.worktreeId ?? null
  const sessionId = scope?.sessionId ?? null
  const key =
    hostId && worktreeId && sessionId ? dismissedSubagentsStorageKey(hostId, worktreeId) : null
  const scopeKey = key && sessionId ? `${key}\0${sessionId}` : ''
  const signature = listed.map((agent) => `${agent.id}\t${agent.state}`).join('\n')
  const listedRef = useRef(listed)
  listedRef.current = listed
  const pendingWrites = useRef(0)
  const [dismissed, setDismissed] = useState<DismissedSubagentStates>({})
  const scopeKeyRef = useRef(scopeKey)
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey
    setDismissed({})
  }

  useEffect(() => {
    if (!key || !hostId || !worktreeId || !sessionId) {
      return
    }
    let stale = false
    const apply = (raw: string | null) => {
      if (stale || pendingWrites.current > 0) {
        return
      }
      const stored = dismissedSubagentsInSession(raw, sessionId)
      const next = nativeChatReconcileDismissals(stored, listedRef.current)
      setDismissed((current) => (sameDismissals(current, next) ? current : next))
      if (next !== stored) {
        pendingWrites.current += 1
        void writeDismissedSubagentSession(hostId, worktreeId, sessionId, next).finally(() => {
          pendingWrites.current -= 1
        })
      }
    }
    const unsubscribe = subscribeMirroredKey(key, apply)
    void readMirroredKeyOrStore(key)
      .then(apply)
      .catch(() => {
        if (!stale) {
          setDismissed({})
        }
      })
    return () => {
      stale = true
      unsubscribe()
    }
  }, [hostId, key, sessionId, worktreeId])

  useEffect(() => {
    if (!hostId || !worktreeId || !sessionId) {
      setDismissed((current) => (Object.keys(current).length === 0 ? current : {}))
      return
    }
    setDismissed((current) => {
      const next = nativeChatReconcileDismissals(current, listedRef.current)
      if (next !== current) {
        pendingWrites.current += 1
        void writeDismissedSubagentSession(hostId, worktreeId, sessionId, next).finally(() => {
          pendingWrites.current -= 1
        })
      }
      return sameDismissals(current, next) ? current : next
    })
  }, [hostId, sessionId, signature, worktreeId])

  const dismiss = useCallback(
    (agents: readonly NativeChatSubagentActivity[]) => {
      if (!hostId || !worktreeId || !sessionId) {
        setDismissed((current) => nativeChatDismissSubagents(current, agents))
        return
      }
      setDismissed((current) => {
        const next = nativeChatDismissSubagents(current, agents)
        pendingWrites.current += 1
        void writeDismissedSubagentSession(hostId, worktreeId, sessionId, next).finally(() => {
          pendingWrites.current -= 1
        })
        return next
      })
    },
    [hostId, sessionId, worktreeId]
  )

  const visible = useMemo(
    () => nativeChatVisibleDismissedSubagents(listed, dismissed),
    [dismissed, listed]
  )
  return { visible, dismiss }
}
