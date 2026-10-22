import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type { StructuredAgentSessionOptionRecord } from '../../../src/shared/structured-agent-session-option-state'
import type { StructuredAgentSessionOptionState } from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait
} from '../../../src/shared/host-model-listing-waits'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

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
  /** This phone created the chat, so it launches the listed default; a reopened one may not. */
  newLaunch: boolean
  /** Where a new chat runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  receiveCatalog: (
    catalog: AgentSessionModelCatalogResult | null,
    event: 'demand' | 'progress' | 'settled'
  ) => void
  activeOptionRecordRef: MutableRefObject<StructuredAgentSessionOptionRecord>
  /** A listing landed after the chat's options were read, which answered without it. */
  onListingLanded?: () => void
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): () => void {
  const {
    activeOptionRecordRef,
    agent,
    client,
    enabled,
    fence,
    newLaunch,
    onListingLanded,
    optionCatalog,
    sessionId,
    updateOptionState,
    worktree
  } = args
  const receiver = useRef(args.receiveCatalog)
  useEffect(() => {
    receiver.current = args.receiveCatalog
  }, [args.receiveCatalog])
  const [rereads, setRereads] = useState(0)
  const recheck = useCallback(() => setRereads((count) => count + 1), [])
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
    const apply = (
      catalog: AgentSessionModelCatalogResult,
      settled = false,
      event: 'demand' | 'progress' = 'demand'
    ): void => {
      if (stale) {
        return
      }
      receiver.current(catalog, settled ? 'settled' : event)
    }
    // A refused or failed read is no list: the built-in one becomes usable, naming nothing.
    const settleBuiltin = (): void => {
      if (!stale) {
        receiver.current(null, 'demand')
      }
    }
    const key = `${agent}\u0000${sessionId}`
    let leave: (() => void) | undefined
    const wait = () => {
      leave = joinHostModelListingWait(
        key,
        () => read(true),
        (listed) => {
          if (stale) {
            return
          }
          if (listed) {
            apply(listed, !listed.listingInProgress && listed.origin !== 'unknown', 'progress')
            if (listed.origin !== 'unknown' && !listed.listingInProgress) {
              onListingLanded?.()
            }
          } else {
            settleBuiltin()
          }
        },
        client
      )
    }
    if (isHostModelListingWaitInFlight(key, client)) {
      wait()
    } else {
      void read(false)
        .then((catalog) => {
          if (stale) {
            return
          }
          apply(catalog)
          if (catalog.listingInProgress) {
            wait()
          }
        })
        .catch(settleBuiltin)
    }
    return () => {
      stale = true
      leave?.()
    }
  }, [
    activeOptionRecordRef,
    agent,
    client,
    enabled,
    fence,
    newLaunch,
    onListingLanded,
    optionCatalog,
    sessionId,
    updateOptionState,
    worktree,
    rereads
  ])
  return recheck
}
