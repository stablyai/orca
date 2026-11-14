import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../../../src/shared/agent-session/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { StructuredAgentSessionOptionRecord } from '../../../../../../src/shared/agent-session/options/reconciliation/structured-agent-session-option-state'
import type { StructuredAgentSessionOptionState } from '../../../../../../src/shared/agent-session/options/structured-agent-session-options'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait
} from '../../../../../../src/shared/host-model-listing-waits'
import { callAgentSession } from '../../agent-session/mobile-structured-agent-session-rpc'
import { usesModelSpecificAcpEfforts } from '../../../../../../src/shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import type { HostModelCatalogLaunch } from '../../../../../../src/shared/agent-session/options/model-catalog/host-model-catalog-snapshot-rules'

/** This world's last host lists for one chat's agent (`useHostModelCatalogCache`). A port, so this hook's
 *  module graph stays free of the query layer for the root-only tests that bundle it. */
export type HostModelCatalogCache = {
  seed: (launch: HostModelCatalogLaunch) => AgentSessionModelCatalogResult | undefined
  record: (worktree: string, catalog: AgentSessionModelCatalogResult) => void
}

// The host answers a waiting read when its first listing lands, within its own 30s picker wait.
const LISTING_WAIT_TIMEOUT_MS = 45_000

// Show host model listings as they arrive without waiting for session attach; unsupported hosts retain a nameless built-in list until options load.
export function useMobileHostModelCatalogUpgrade(args: {
  agent: string | null
  selectedModel?: string
  modelCatalogCache?: HostModelCatalogCache | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  /** This phone created the chat, so it launches the listed default; a reopened one may not. */
  newLaunch: boolean
  /** Where a new chat runs: the host names no default its config could replace. */
  worktree?: string
  /** The chat has a turn or a send, so its answers are its own account's, which a new chat may no longer pin. */
  hasTurn?: boolean
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
    modelCatalogCache,
    newLaunch,
    onListingLanded,
    optionCatalog,
    sessionId,
    updateOptionState,
    worktree
  } = args
  const receiver = useRef(args.receiveCatalog)
  const recordsNewChat = useRef(newLaunch && args.hasTurn !== true)
  const recordingWait = useRef<string | null>(null)
  useEffect(() => {
    receiver.current = args.receiveCatalog
    recordsNewChat.current = newLaunch && args.hasTurn !== true
  }, [args.receiveCatalog, newLaunch, args.hasTurn])
  const [rereads, setRereads] = useState(0)
  const selectedModel = usesModelSpecificAcpEfforts(agent ?? '') ? args.selectedModel : undefined
  const recheck = useCallback(() => setRereads((count) => count + 1), [])
  useEffect(() => {
    if (!client || !sessionId || !enabled || !agent || !optionCatalog) {
      return
    }
    let stale = false
    const key = `${agent}\u0000${sessionId}`
    // A read sent before the chat's first turn or send answers for the account a new chat pins;
    // so does the listing such a read waits on, whichever later run picks that up. Each new read decides alone.
    const readRecords = recordsNewChat.current
    const waitRecords =
      readRecords || (recordingWait.current === key && isHostModelListingWaitInFlight(key, client))
    const params = {
      agent,
      sessionId,
      ...(selectedModel ? { selectedModel } : {}),
      ...(newLaunch && worktree ? { worktree } : {})
    }
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
      event: 'demand' | 'progress' = 'demand',
      records = readRecords
    ): void => {
      if (stale) {
        return
      }
      // A new chat's answer is the account's a new chat pins, so the next chat starts from it.
      if (records) {
        modelCatalogCache?.record(worktree ?? '', catalog)
      }
      receiver.current(catalog, settled ? 'settled' : event)
    }
    // A refused or failed read is no list: the built-in one becomes usable, naming nothing.
    const settleBuiltin = (): void => {
      if (!stale) {
        receiver.current(null, 'demand')
      }
    }
    let leave: (() => void) | undefined
    const wait = () => {
      recordingWait.current = waitRecords ? key : null
      leave = joinHostModelListingWait(
        key,
        () => read(true),
        (listed) => {
          if (stale) {
            return
          }
          if (listed) {
            apply(
              listed,
              !listed.listingInProgress && listed.origin !== 'unknown',
              'progress',
              waitRecords
            )
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
      if (selectedModel) {
        void read(false)
          .then((catalog) => apply(catalog))
          .catch(() => {})
      }
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
    modelCatalogCache,
    newLaunch,
    onListingLanded,
    optionCatalog,
    sessionId,
    selectedModel,
    updateOptionState,
    worktree,
    rereads
  ])
  return recheck
}
