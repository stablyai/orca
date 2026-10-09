import { useEffect, useMemo, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type { NativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { mobileCreatedStructuredSession } from './mobile-created-structured-sessions'

// The host answers a waiting read when its first listing lands, within its own 30s picker wait.
const LISTING_WAIT_TIMEOUT_MS = 45_000

/**
 * The desktop's host-catalog upgrade on the phone: the picker lists the account's models from the
 * host store while the session's own options read may still wait on its attach. Until the host
 * answers it shows the quiet placeholder; it never waits on a listing: a first listing still
 * running lands in place. An older host refuses the method, and the built-in list stands, naming
 * nothing, until the options read lands.
 */
export function useMobileHostModelCatalogUpgrade(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): void {
  const {
    activeOptionRecordRef,
    agent,
    client,
    enabled,
    fence,
    optionCatalog,
    sessionId,
    updateOptionState
  } = args
  // A chat this phone created runs the listed default, as a desktop chat its own view launched
  // does; where it runs names no default its config could replace. A reopened one may not.
  const createdHere = useMemo(
    () => (sessionId ? mobileCreatedStructuredSession(sessionId) : undefined),
    [sessionId]
  )
  const newLaunch = createdHere !== undefined
  const worktree = createdHere?.worktree
  useEffect(() => {
    if (!client || !sessionId || !enabled || !agent || !optionCatalog) {
      return
    }
    let stale = false
    const params = { agent, sessionId, ...(newLaunch && worktree ? { worktree } : {}) }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      waitForListing
        ? callAgentSession(
            client,
            'agentSession.modelCatalog',
            { ...params, waitForListing },
            LISTING_WAIT_TIMEOUT_MS
          )
        : callAgentSession(client, 'agentSession.modelCatalog', params)
    // A pick made meanwhile stays on the record; a listing only replaces the list it is picked from.
    const apply = (catalog: AgentSessionModelCatalogResult): void => {
      if (stale) {
        return
      }
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, { newLaunch })
          : current
      )
    }
    // A refused or failed read is no list: the built-in one becomes usable, naming nothing.
    const settleBuiltin = (): void => {
      if (!stale) {
        updateOptionState((current) =>
          current.record === activeOptionRecordRef.current
            ? settleStructuredAgentSessionBuiltinCatalog(current)
            : current
        )
      }
    }
    void read(false)
      .then((catalog) => {
        if (catalog.origin === 'unknown' && catalog.listingInProgress === true && !stale) {
          // Usable on the built-in list while the listing runs; it lands in place.
          apply(catalog)
          return read(true).then(apply)
        }
        apply(catalog)
        return undefined
      })
      .catch(settleBuiltin)
    return () => {
      stale = true
    }
  }, [
    activeOptionRecordRef,
    agent,
    client,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    sessionId,
    updateOptionState,
    worktree
  ])
}
