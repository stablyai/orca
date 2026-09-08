import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'

export function useMobileNativeChatDraftPersistence(args: {
  draftKey: string | null
  worktreeId: string
  tabId: string | null
  text: string
  drafts: Record<string, string>
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>
  persistence: HostSessionChatDraftOperations | null
}): { markDraftEdited: () => void } {
  const { draftKey, worktreeId, tabId, text, drafts, setDrafts, persistence } = args
  const editVersionRef = useRef<Record<string, number>>({})
  const hydratedKeysRef = useRef(new Set<string>())
  const draftsRef = useRef(drafts)
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  const markDraftEdited = useCallback(() => {
    if (!draftKey) {
      return
    }
    hydratedKeysRef.current.add(draftKey)
    editVersionRef.current[draftKey] = (editVersionRef.current[draftKey] ?? 0) + 1
  }, [draftKey])

  useEffect(() => {
    if (!draftKey || !tabId || !persistence || hydratedKeysRef.current.has(draftKey)) {
      return
    }
    let active = true
    const editVersion = editVersionRef.current[draftKey] ?? 0
    void persistence
      .load(worktreeId, tabId)
      .then((stored) => {
        if (!active) {
          return
        }
        hydratedKeysRef.current.add(draftKey)
        if ((editVersionRef.current[draftKey] ?? 0) === editVersion) {
          setDrafts((previous) => ({ ...previous, [draftKey]: stored }))
        }
      })
      .catch(() => {
        hydratedKeysRef.current.add(draftKey)
      })
    return () => {
      active = false
    }
  }, [draftKey, persistence, setDrafts, tabId, worktreeId])

  useEffect(() => {
    if (!draftKey || !tabId || !persistence || !hydratedKeysRef.current.has(draftKey)) {
      return
    }
    const timer = setTimeout(() => {
      void persistence.save(worktreeId, tabId, text).catch(() => {})
    }, 250)
    return () => clearTimeout(timer)
  }, [draftKey, persistence, tabId, text, worktreeId])

  useEffect(() => {
    if (!draftKey || !tabId || !persistence) {
      return
    }
    return () => {
      if (hydratedKeysRef.current.has(draftKey)) {
        void persistence.save(worktreeId, tabId, draftsRef.current[draftKey] ?? '').catch(() => {})
      }
    }
  }, [draftKey, persistence, tabId, worktreeId])

  return { markDraftEdited }
}
